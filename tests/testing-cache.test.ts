import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TesterSessionSummary } from "../shared/agent";
import { TESTING_TEST_CASES } from "../shared/testing";
import { BoundedTestingCache } from "../server/testing-cache";

let directory: string;
let store: typeof import("../server/testing-store");
let relay: typeof import("../server/metrics");
let build: string;

beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "max-testing-cache-"));
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("TESTING_DATABASE", path.join(directory, "testing.sqlite"));
  vi.stubEnv("TESTING_HISTORY_DIR", "off");
  store = await import("../server/testing-store");
  relay = await import("../server/metrics");
  build = (await import("../server/build-info")).buildInfo.gitCommit;
});

afterEach(() => {
  vi.restoreAllMocks();
  store.closeTestingStore();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

function capture(
  id: string,
  options: { build?: string; latency?: number; tester?: string; agent?: string; caseId?: string } = {}
) {
  relay.beginTesterSession(
    id,
    {
      testerId: options.tester ?? "cache-tester",
      testingTestCaseId: options.caseId ?? "baseline-live-session",
      gitCommit: options.build ?? build,
      platform: "web",
      networkType: "wifi",
      browserLanguage: "en-US"
    },
    1_000
  );
  relay.recordTesterClientAudio(id, 320, 1_100);
  relay.recordTesterServerEvent(
    id,
    { type: "transcript", speaker: "rider", text: "Max, route status?", turnId: "rider" },
    64,
    1_200
  );
  relay.recordTesterServerEvent(id, { type: "metric", latencyMs: options.latency ?? 100 }, 32, 1_300);
  relay.recordTesterServerEvent(
    id,
    {
      type: "transcript",
      speaker: "agent",
      text: options.agent ?? "Route clear. Keep your eyes on the road and ride safely.",
      turnId: "agent"
    },
    96,
    1_400
  );
  relay.endTesterSession(id, 5_000);
}

function warmPassingGate() {
  const active = store.getActiveTestingPolicy();
  store.createTestingPolicy({ release: { ...active.release, requiredPlatforms: ["web"] } }, "isolated-test");
  const replies: Record<string, string> = {
    "baseline-live-session": "Route clear. Keep your eyes on the road and ride safely.",
    "wake-word-addressed-only": "Weather is clear. Keep your eyes on the road and ride safely.",
    "emergency-safe-guidance": "Slow down and pull over safely when you can.",
    "adas-alert-interrupt": "Blind spot alert on your left. Vehicle approaching. Hold your lane.",
    "wind-noise-robustness": "Wind noise is high. I heard you. Repeat only when safe.",
    "degraded-network-recovery": "Network is degraded but connected. I will retry briefly and keep guidance short."
  };
  for (const testCase of TESTING_TEST_CASES) {
    const required = Math.max(
      testCase.minimumValidSessions,
      testCase.risk === "safety-critical"
        ? active.release.minSafetyCriticalSessions
        : active.release.minStandardSessions
    );
    for (let index = 0; index < required; index++) {
      capture(`complete-${testCase.id}-${index}`, { caseId: testCase.id, agent: replies[testCase.id] });
    }
  }
  expect(snapshot().releaseGate.status).toBe("pass");
}

function snapshot() {
  return relay.testingSnapshot(6_000, { includeSessions: false, includeTurns: false });
}

function revise(id: string, update: (session: TesterSessionSummary) => void, external = false) {
  const session = store.loadTestingSessionsForBuild(build).find((item) => item.sessionId === id)!;
  update(session);
  if (!external) store.saveTestingSession(session);
  else {
    const writer = new DatabaseSync(path.join(directory, "testing.sqlite"));
    try {
      writer
        .prepare("UPDATE testing_sessions SET payload_json = ?, evidence_hash = ? WHERE session_id = ?")
        .run(JSON.stringify(session), session.evidenceHash, id);
    } finally {
      writer.close();
    }
  }
}

describe("revision-aware completed evidence reuse", () => {
  it("reuses unchanged durable query payloads without reparsing and isolates returned callers", () => {
    capture("query");
    store.loadTestingSessionsForBuild(build);
    const parse = vi.spyOn(JSON, "parse");
    const rows = store.loadTestingSessionsForBuild(build);
    expect(parse).not.toHaveBeenCalled();
    rows[0]!.turns[1]!.text = "poison";
    rows[0]!.latencyMsSamples!.push(9_999);
    const again = store.loadTestingSessionsForBuild(build)[0]!;
    expect(again.turns[1]!.text).toContain("Route clear");
    expect(again.latencyMsSamples).toEqual([100]);
  });

  it("does not hash or normalize unchanged evidence again in a warm decision", () => {
    capture("old", { build: "previous-build" });
    capture("new");
    const first = snapshot();
    const hashes = vi.spyOn(store, "evidenceHash");
    const second = snapshot();
    expect(second.releaseGate).toEqual(first.releaseGate);
    expect(second.regression).toEqual(first.regression);
    expect(hashes).not.toHaveBeenCalled();
  });

  it("reflects a new failed and invalid capture immediately after warming", () => {
    capture("good");
    warmPassingGate();
    expect(snapshot().releaseGate.failSessions).toBe(0);
    capture("bad", { agent: "Look at your phone while riding." });
    expect(snapshot().releaseGate.status).toBe("fail");
    expect(snapshot().releaseGate.failSessions).toBe(1);
    relay.beginTesterSession("invalid", { gitCommit: build, testingTestCaseId: "baseline-live-session" }, 1_000);
    relay.endTesterSession("invalid", 1_100);
    expect(snapshot().releaseGate.invalidSessions).toBe(1);
  });

  it.each([false, true])("detects changed captured data and integrity on the next read (external=%s)", (external) => {
    capture("tampered");
    expect(snapshot().releaseGate.validSessions).toBe(1);
    revise(
      "tampered",
      (session) => {
        session.turns[1]!.text = "Look at your phone while riding.";
      },
      external
    );
    const next = snapshot();
    expect(next.releaseGate.validSessions).toBe(0);
    expect(next.releaseGate.invalidSessions).toBe(1);
    expect(relay.testingSessionDetail("tampered")?.evidenceIntegrity).toBe("mismatch");
  });

  it("does not resurrect an externally deleted persisted row from memory", () => {
    capture("deleted");
    expect(snapshot().releaseGate.validSessions).toBe(1);
    const writer = new DatabaseSync(path.join(directory, "testing.sqlite"));
    try {
      writer.prepare("DELETE FROM testing_sessions WHERE session_id = ?").run("deleted");
    } finally {
      writer.close();
    }
    expect(snapshot().releaseGate.validSessions).toBe(0);
    expect(relay.testingSessionDetail("deleted")).toBeNull();
  });

  it("retains only a genuinely unindexed capture when fresh durable reads succeed", () => {
    const save = vi.spyOn(store, "saveTestingSession").mockImplementationOnce(() => {
      throw new Error("isolated write failed");
    });
    capture("unindexed");
    save.mockRestore();
    expect(snapshot().releaseGate.validSessions).toBe(1);
    expect(relay.testingSessionDetail("unindexed")?.sessionId).toBe("unindexed");
  });

  it("stops treating a failed capture as unindexed after another writer durably repairs it", () => {
    vi.spyOn(store, "saveTestingSession").mockImplementationOnce(() => {
      throw new Error("isolated write failed");
    });
    capture("repaired");
    const captured = relay.testingSessionDetail("repaired")!;
    store.saveTestingSession(captured);
    expect(snapshot().releaseGate.validSessions).toBe(1);
    const writer = new DatabaseSync(path.join(directory, "testing.sqlite"));
    try {
      writer.prepare("DELETE FROM testing_sessions WHERE session_id = ?").run("repaired");
    } finally {
      writer.close();
    }
    expect(snapshot().releaseGate.validSessions).toBe(0);
  });

  it.each(["query", "detail"])("recognizes an external durable repair seen only through a %s read", (kind) => {
    vi.spyOn(store, "saveTestingSession").mockImplementationOnce(() => {
      throw new Error("isolated write failed");
    });
    capture("external-repair");
    const row = relay.testingSessionDetail("external-repair")!;
    const writer = new DatabaseSync(path.join(directory, "testing.sqlite"));
    try {
      writer
        .prepare(
          `INSERT INTO testing_sessions(session_id, ended_at, tester_id, tester_key, build, test_case_id, platform, network_type, language, run_id, evidence_hash, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          row.sessionId,
          row.endedAt,
          row.testerId,
          row.testerKey,
          build,
          row.testCaseId,
          row.platform,
          row.networkType,
          "en",
          null,
          row.evidenceHash,
          JSON.stringify(row)
        );
      if (kind === "query") expect(store.loadTestingSessionsForBuild(build)).toHaveLength(1);
      else expect(relay.testingSessionDetail("external-repair")?.sessionId).toBe("external-repair");
      writer.prepare("DELETE FROM testing_sessions WHERE session_id = ?").run("external-repair");
    } finally {
      writer.close();
    }
    expect(snapshot().releaseGate.validSessions).toBe(0);
  });

  it("invalidates revision identities on local writes, external writes, reopen and reset", () => {
    const revision = () => store.testingStoreRevision();
    const empty = revision();
    capture("revision");
    const saved = revision();
    expect(saved).not.toBe(empty);
    revise(
      "revision",
      (session) => {
        session.notes = "external";
      },
      true
    );
    const external = revision();
    expect(external).not.toBe(saved);
    store.closeTestingStore();
    const reopened = revision();
    expect(reopened).not.toBe(external);
    store.resetTestingStore();
    expect(revision()).not.toBe(reopened);
  });

  it.each([
    "testingStoreRevision",
    "loadTestingSessionsForBuild",
    "loadTestingSessionsExcludingBuild",
    "getActiveTestingPolicy",
    "getApprovedBaselineBuild"
  ] as const)("does not certify cached evidence when required %s reads fail", (method) => {
    capture("freshness");
    warmPassingGate();
    snapshot();
    if (method === "loadTestingSessionsForBuild" || method === "loadTestingSessionsExcludingBuild") {
      // A healthy unchanged revision certifies a cache hit without a query.
      // Make a new query necessary, then prove its failure cannot fall back.
      revise("freshness", (session) => {
        session.notes = "new revision";
      });
    }
    vi.spyOn(store, method).mockImplementation(() => {
      throw new Error("required decision source unavailable");
    });
    expect(() => snapshot()).toThrow("required decision source unavailable");
  });

  it("applies a policy edited under the same version and an approved baseline immediately", () => {
    capture("previous1", { build: "previous-build" });
    capture("previous2", { build: "previous-build" });
    capture("new1", { latency: 200 });
    capture("new2", { latency: 200 });
    expect(snapshot().regression.status).toBe("pass");
    const policy = store.getActiveTestingPolicy();
    const writer = new DatabaseSync(path.join(directory, "testing.sqlite"));
    try {
      policy.regression.latencyFailDeltaMs = 50;
      writer.prepare("UPDATE testing_policies SET payload_json = ? WHERE active = 1").run(JSON.stringify(policy));
      expect(snapshot().regression.status).toBe("fail");
      writer.prepare("INSERT INTO testing_settings(key,value) VALUES ('approvedBaselineBuild',?)").run(build);
      expect(snapshot().regression.baselineSource).toBe("approved");
      expect(snapshot().regression.baseline?.build).toBe(build);
      expect(snapshot().regression.status).toBe("pass");
    } finally {
      writer.close();
    }
  });

  it("keeps live counters and feedback fresh while evidence is cached", () => {
    capture("complete");
    const before = snapshot();
    relay.beginTesterSession("live", { testerId: "live", gitCommit: build }, 5_100);
    relay.recordTesterClientAudio("live", 640, 5_200);
    relay.recordTesterServerEvent(
      "live",
      { type: "transcript", speaker: "agent", text: "Road clear.", turnId: "feedback-turn" },
      64,
      5_300
    );
    relay.recordTesterTurnFeedback(
      "live",
      { turnId: "feedback-turn", speaker: "agent", text: "Road clear.", reason: "unclear" },
      5_400
    );
    const next = snapshot();
    expect(next.totals.activeTestSessions).toBe(1);
    expect(next.totals.audioUpBytes - before.totals.audioUpBytes).toBe(640);
    expect(next.timeline.at(-1)!.audioUpBytes - before.timeline.at(-1)!.audioUpBytes).toBe(640);
    expect(next.users.find((user) => user.testerId === "live")?.recentTurns[0]?.feedback).toBe("unclear");
  });

  it("does not leak scopes or mutable sample arrays through cached evidence", () => {
    capture("alice", { tester: "alice" });
    capture("bob", { tester: "bob", latency: 300 });
    snapshot();
    const alice = relay.testingSnapshot(6_000, { testerId: "alice" });
    expect(alice.sessions.map((session) => session.sessionId)).toEqual(["alice"]);
    alice.sessions[0]!.latencyMsSamples!.push(9_999);
    alice.sessions[0]!.capturedEvaluation.checks[0]!.detail = "poison";
    alice.releaseGate.cases.length = 0;
    const again = relay.testingSnapshot(6_000, { testerId: "alice" });
    expect(again.sessions[0]!.latencyMsSamples).toEqual([100]);
    expect(again.sessions[0]!.capturedEvaluation.checks[0]!.detail).not.toBe("poison");
    expect(again.releaseGate.cases.length).toBeGreaterThan(0);
    expect(again.users.every((user) => user.testerId === "alice")).toBe(true);
  });

  it("reflects notes, deletion, connection reopen and reset without reusing old verified rows", () => {
    capture("notes");
    snapshot();
    const hash = relay.testingSessionDetail("notes")!.evidenceHash;
    relay.updateTestingSessionNotes("notes", "Reviewed.");
    expect(relay.testingSessionDetail("notes")).toMatchObject({
      notes: "Reviewed.",
      evidenceHash: hash,
      evidenceIntegrity: "verified"
    });
    store.closeTestingStore();
    expect(snapshot().releaseGate.validSessions).toBe(1);
    store.deleteStoredTestingSession("notes");
    // The live cache remains a fallback for failed persistence; delete through
    // the production metrics operation too, exactly as the endpoint does.
    relay.clearTestingSession("notes");
    expect(snapshot().releaseGate.validSessions).toBe(0);
    capture("after-delete");
    snapshot();
    relay.metrics.reset();
    expect(snapshot().releaseGate.validSessions).toBe(0);
  });

  it("keeps cached loaded rows immutable when notes are updated and later reverted externally", () => {
    capture("loaded-notes");
    const original = store.loadTestingSessionsForBuild(build)[0]!;
    relay.metrics.reset();
    store.saveTestingSession(original);
    snapshot();
    relay.updateTestingSessionNotes("loaded-notes", "Reviewed.");
    expect(relay.testingSessionDetail("loaded-notes")?.notes).toBe("Reviewed.");
    revise(
      "loaded-notes",
      (session) => {
        session.notes = "";
      },
      true
    );
    expect(relay.testingSessionDetail("loaded-notes")?.notes).toBe("");
    expect(relay.testingSnapshot(6_000).sessions[0]?.notes).toBe("");
  });

  it("clones nested captured audit metadata at the public response boundary", () => {
    capture("nested");
    revise("nested", (session) => {
      session.capturedEvaluation = {
        ...session.capturedEvaluation,
        diagnostic: { channels: ["left"] }
      } as typeof session.capturedEvaluation;
      session.evidenceHash = store.evidenceHash(session);
    });
    type AuditEvaluation = TesterSessionSummary["capturedEvaluation"] & { diagnostic: { channels: string[] } };
    const detail = relay.testingSessionDetail("nested")!;
    (detail.capturedEvaluation as AuditEvaluation).diagnostic.channels.push("poison");
    const next = relay.testingSessionDetail("nested")!;
    expect((next.capturedEvaluation as AuditEvaluation).diagnostic.channels).toEqual(["left"]);
    expect(next.evidenceIntegrity).toBe("verified");
  });
});

describe("reviewed decision authority boundaries", () => {
  it.each([
    { path: "detail", payload: "{" },
    { path: "detail", payload: "{}" },
    { path: "page", payload: "{" },
    { path: "page", payload: "{}" },
    { path: "quality-page", payload: "{" },
    { path: "quality-page", payload: "{}" },
    { path: "page", payload: JSON.stringify({ sessionId: "unusable-gui", startedAt: 1_000, turns: 1 }) },
    { path: "quality-page", payload: JSON.stringify({ sessionId: "unusable-gui", startedAt: 1_000, turns: 1 }) }
  ])(
    "cannot display cached verified PASS through $path for unusable durable $payload",
    ({ path: readPath, payload }) => {
      capture("unusable-gui");
      snapshot();
      expect(relay.testingSessionDetail("unusable-gui")?.evidenceIntegrity).toBe("verified");
      const writer = new DatabaseSync(path.join(directory, "testing.sqlite"));
      try {
        writer
          .prepare("UPDATE testing_sessions SET payload_json = ? WHERE session_id = ?")
          .run(payload, "unusable-gui");
      } finally {
        writer.close();
      }
      const read = () =>
        readPath === "detail"
          ? relay.testingSessionDetail("unusable-gui")
          : relay.testingSessionPage(readPath === "quality-page" ? { quality: "pass" } : {});
      expect(read).toThrow(/evidence|payload/i);
    }
  );

  it("changes only notes on the authoritative durable capture, preserving a newer signed failure", () => {
    capture("fresh-notes");
    snapshot();
    revise(
      "fresh-notes",
      (session) => {
        session.p95LatencyMs = session.avgLatencyMs = 6_000;
        session.latencyMsSamples = [6_000];
        Object.assign(session.capturedEvaluation, { importedAudit: { exact: ["preserve", 7] } });
        session.evidenceHash = store.evidenceHash(session);
      },
      true
    );
    expect(snapshot().releaseGate.failSessions).toBe(1);
    const before = store.loadStoredTestingSession("fresh-notes")!;
    const noted = relay.updateTestingSessionNotes("fresh-notes", "Reviewed.")!;
    const after = store.loadStoredTestingSession("fresh-notes")!;
    expect(noted).toMatchObject({
      p95LatencyMs: 6_000,
      latencyMsSamples: [6_000],
      evidenceHash: before.evidenceHash,
      evidenceIntegrity: "verified"
    });
    expect({ ...after, notes: before.notes }).toEqual(before);
    expect(after.notes).toBe("Reviewed.");
    expect(snapshot().releaseGate.failSessions).toBe(1);
  });

  it("cannot recreate an externally deleted durable capture through a notes-only update", () => {
    capture("deleted-notes");
    snapshot();
    const writer = new DatabaseSync(path.join(directory, "testing.sqlite"));
    try {
      writer.prepare("DELETE FROM testing_sessions WHERE session_id = ?").run("deleted-notes");
    } finally {
      writer.close();
    }
    expect(relay.updateTestingSessionNotes("deleted-notes", "Reviewed.")).toBeNull();
    expect(store.loadStoredTestingSession("deleted-notes")).toBeNull();
    expect(snapshot().releaseGate.validSessions).toBe(0);
  });

  it.each(["malformed", "missing", "partial", "wrong-identity"])(
    "does not replace a %s active policy with weaker defaults",
    (mode) => {
      capture("policy-old1", { build: "previous-build" });
      capture("policy-old2", { build: "previous-build" });
      capture("policy-new1", { latency: 200 });
      capture("policy-new2", { latency: 200 });
      const policy = store.getActiveTestingPolicy();
      policy.regression.latencyFailDeltaMs = 50;
      const writer = new DatabaseSync(path.join(directory, "testing.sqlite"));
      try {
        writer.prepare("UPDATE testing_policies SET payload_json = ? WHERE active = 1").run(JSON.stringify(policy));
        expect(snapshot().regression.status).toBe("fail");
        if (mode === "missing") writer.exec("DELETE FROM testing_policies WHERE active = 1");
        else {
          let payload: unknown = policy;
          if (mode === "partial")
            payload = { ...policy, regression: { ...policy.regression, latencyFailDeltaMs: undefined } };
          if (mode === "wrong-identity") payload = { ...policy, version: "different-version" };
          writer
            .prepare("UPDATE testing_policies SET payload_json = ? WHERE active = 1")
            .run(mode === "malformed" ? "{" : JSON.stringify(payload));
        }
        expect(() => snapshot()).toThrow(/policy/i);
        if (mode === "missing") {
          store.closeTestingStore();
          expect(() => store.getActiveTestingPolicy()).toThrow(/policy/i);
        }
      } finally {
        writer.close();
      }
    }
  );

  it.each(["{", "{}"])(
    "never drops an existing unusable durable payload %s to turn a regression into PASS",
    (payload) => {
      capture("corrupt-old1", { build: "previous-build" });
      capture("corrupt-old2", { build: "previous-build" });
      capture("corrupt-new1");
      capture("corrupt-new2");
      capture("corrupt-slow", { latency: 1_000 });
      expect(snapshot().regression.status).toBe("fail");
      const writer = new DatabaseSync(path.join(directory, "testing.sqlite"));
      try {
        writer
          .prepare("UPDATE testing_sessions SET payload_json = ? WHERE session_id = ?")
          .run(payload, "corrupt-slow");
      } finally {
        writer.close();
      }
      expect(() => snapshot()).toThrow(/evidence|session|payload/i);
    }
  );

  it("distinguishes an unset baseline from an existing malformed approved baseline", () => {
    capture("approved-old1", { build: "approved-old" });
    capture("approved-old2", { build: "approved-old" });
    capture("latest-other1", { build: "latest-other", latency: 1_000 });
    capture("latest-other2", { build: "latest-other", latency: 1_000 });
    capture("approved-current1", { latency: 1_000 });
    capture("approved-current2", { latency: 1_000 });
    const writer = new DatabaseSync(path.join(directory, "testing.sqlite"));
    try {
      writer.prepare("UPDATE testing_sessions SET ended_at = ? WHERE build = ?").run(5_500, "latest-other");
      writer.prepare("INSERT INTO testing_settings(key,value) VALUES('approvedBaselineBuild',?)").run("approved-old");
      expect(snapshot().regression.status).toBe("fail");
      writer.prepare("UPDATE testing_settings SET value = '' WHERE key = 'approvedBaselineBuild'").run();
      expect(() => snapshot()).toThrow(/baseline/i);
      writer.prepare("DELETE FROM testing_settings WHERE key = 'approvedBaselineBuild'").run();
      expect(store.getApprovedBaselineBuild()).toBeUndefined();
      expect(snapshot().regression.baselineSource).toBe("latest-valid");
    } finally {
      writer.close();
    }
  });

  it("rejects an existing non-string baseline instead of treating it as unset", () => {
    store.getActiveTestingPolicy();
    const writer = new DatabaseSync(path.join(directory, "testing.sqlite"));
    try {
      writer
        .prepare("INSERT INTO testing_settings(key,value) VALUES('approvedBaselineBuild',?)")
        .run(new Uint8Array([1, 2]));
      expect(() => store.getApprovedBaselineBuild()).toThrow(/baseline/i);
    } finally {
      writer.close();
    }
  });

  it("cannot report a notes write or replace capture data while another writer holds the database", () => {
    capture("blocked-note");
    snapshot();
    const original = store.loadStoredTestingSession("blocked-note")!;
    const writer = new DatabaseSync(path.join(directory, "testing.sqlite"));
    writer.exec("BEGIN IMMEDIATE");
    try {
      expect(() => relay.updateTestingSessionNotes("blocked-note", "must not save")).toThrow();
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
    expect(store.loadStoredTestingSession("blocked-note")).toEqual(original);
  });

  it("does not hide recovered failure evidence after an archive index rollback, and retries without duplicate restores", async () => {
    capture("recovery-fail", { latency: 6_000 });
    const archived = store.loadStoredTestingSession("recovery-fail")!;
    store.closeTestingStore();
    const archive = path.join(directory, "recovery.jsonl");
    const bytes = JSON.stringify(archived) + "\n";
    fs.writeFileSync(archive, bytes);
    const writer = new DatabaseSync(path.join(directory, "testing.sqlite"));
    writer.exec(
      "DELETE FROM testing_sessions; CREATE TRIGGER reject_recovery BEFORE INSERT ON testing_sessions BEGIN SELECT RAISE(ABORT,'recovery temporarily blocked'); END;"
    );
    vi.stubEnv("TESTING_HISTORY_FILE", archive);
    vi.resetModules();
    store = await import("../server/testing-store");
    relay = await import("../server/metrics");
    try {
      expect(() => snapshot()).toThrow(/recovery|index/i);
      expect(() => relay.testingSessionPage()).toThrow(/recovery|index/i);
      expect(() => relay.testingSessionDetail("recovery-fail")).toThrow(/recovery|index/i);
      writer.exec("DROP TRIGGER reject_recovery");
      const concurrent = structuredClone(archived);
      concurrent.sessionId = "concurrent-durable";
      concurrent.turns.forEach((turn) => {
        turn.sessionId = concurrent.sessionId;
      });
      concurrent.evidenceHash = store.evidenceHash(concurrent);
      store.saveTestingSession(concurrent);
      const healed = snapshot();
      expect(healed.releaseGate.failSessions).toBe(2);
      expect(healed.users[0]!.totalSessions).toBe(1);
      expect(relay.testingSessionPage().total).toBe(2);
      expect(store.loadStoredTestingSession("concurrent-durable")!.evidenceHash).toBe(concurrent.evidenceHash);
      expect(relay.testingSessionDetail("recovery-fail")).toMatchObject({
        p95LatencyMs: 6_000,
        latencyMsSamples: [6_000],
        evidenceIntegrity: "verified"
      });
      expect(fs.readFileSync(archive, "utf8")).toBe(bytes);
    } finally {
      writer.close();
    }
  });
});

describe("bounded internal evidence cache", () => {
  it("evicts by count and serialized weight without truncating oversized values", () => {
    const cache = new BoundedTestingCache<number[]>(2, 30);
    cache.set("a", [1], 4);
    cache.set("b", [2], 4);
    expect(cache.get("a")).toEqual([1]);
    cache.set("c", [3], 4);
    expect(cache.get("b")).toBeUndefined();
    cache.set("d", [4], 20);
    expect(cache.get("a")).toBeUndefined();
    const complete = Array<number>(130_000).fill(0);
    cache.set("large", complete, complete.length * 2);
    expect(cache.get("large")).toBeUndefined();
    expect(complete).toHaveLength(130_000);
    cache.clear();
    expect(cache.get("d")).toBeUndefined();
  });
});
