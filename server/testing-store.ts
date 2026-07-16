// Durable QA operations and evidence index.
//
// Completed session payloads still have an append-oriented JSONL archive for
// recovery/export, while SQLite provides indexed reads, run orchestration,
// reviews, policy history, audit events, and approved-baseline state. The
// database lives outside the deploy tree beside the existing accounts/history.

import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TesterSessionSummary } from "../shared/agent";
import {
  DEFAULT_TESTING_POLICY,
  TESTING_TEST_CASES,
  normalizeTestingBuildIdentity,
  testingBuildsMatch,
  type TestingAssignment,
  type TestingAuditEvent,
  type TestingOperationsSnapshot,
  type TestingPlatform,
  type TestingPolicy,
  type TestingReview,
  type TestingReviewSeverity,
  type TestingReviewStatus,
  type TestingRun,
  type TestingRunRequirement,
  type TestingRunStatus,
  type TestingSessionPage,
  type TestingSessionQuery
} from "../shared/testing";
import { createLogger } from "./logger";
import { reevaluateStoredSession } from "./testing-evaluator";
import {
  DEFAULT_TESTING_STORAGE_DIRECTORY,
  ensureTestingStorageDirectorySync,
  secureTestingFileSync
} from "./testing-storage";

const log = createLogger("testing-store");

let databaseInstance: DatabaseSync | null = null;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanString(value: unknown, fallback = "", maxLength = 240): string {
  if (typeof value !== "string") return fallback;
  const clean = value
    .normalize("NFKC")
    .split("")
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? " " : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return clean.slice(0, maxLength) || fallback;
}

function resolveDatabasePath(): string {
  const configured = process.env.TESTING_DATABASE?.trim();
  if (configured?.toLowerCase() === "off" || process.env.NODE_ENV === "test") return ":memory:";
  if (configured) return configured;
  return path.join(DEFAULT_TESTING_STORAGE_DIRECTORY, "testing.sqlite");
}

export function testingStorePersistent(): boolean {
  return resolveDatabasePath() !== ":memory:";
}

function database(): DatabaseSync {
  if (databaseInstance) return databaseInstance;
  const filePath = resolveDatabasePath();
  if (filePath !== ":memory:") {
    ensureTestingStorageDirectorySync(filePath);
    secureTestingFileSync(filePath);
    secureTestingFileSync(`${filePath}-wal`);
    secureTestingFileSync(`${filePath}-shm`);
  }
  const db = new DatabaseSync(filePath);
  if (filePath !== ":memory:") secureTestingFileSync(filePath);
  db.exec("PRAGMA foreign_keys = ON");
  if (filePath !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    secureTestingFileSync(filePath);
    secureTestingFileSync(`${filePath}-wal`);
    secureTestingFileSync(`${filePath}-shm`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS testing_sessions (
      session_id TEXT PRIMARY KEY,
      ended_at INTEGER NOT NULL,
      tester_id TEXT NOT NULL,
      tester_key TEXT NOT NULL,
      build TEXT NOT NULL,
      test_case_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      network_type TEXT NOT NULL,
      language TEXT NOT NULL,
      run_id TEXT,
      evidence_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_testing_sessions_ended ON testing_sessions(ended_at DESC);
    CREATE INDEX IF NOT EXISTS idx_testing_sessions_build_case ON testing_sessions(build, test_case_id);
    CREATE INDEX IF NOT EXISTS idx_testing_sessions_build_ended ON testing_sessions(build, ended_at DESC);
    CREATE INDEX IF NOT EXISTS idx_testing_sessions_tester ON testing_sessions(tester_id, ended_at DESC);
    CREATE INDEX IF NOT EXISTS idx_testing_sessions_run ON testing_sessions(run_id, ended_at DESC);

    CREATE TABLE IF NOT EXISTS testing_runs (
      id TEXT PRIMARY KEY,
      build TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_testing_runs_updated ON testing_runs(updated_at DESC);

    CREATE TABLE IF NOT EXISTS testing_reviews (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      severity TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_testing_reviews_session ON testing_reviews(session_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_testing_reviews_status ON testing_reviews(status, severity, updated_at DESC);

    CREATE TABLE IF NOT EXISTS testing_policies (
      version TEXT PRIMARY KEY,
      active INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS testing_audit (
      id TEXT PRIMARY KEY,
      at INTEGER NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      detail_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_testing_audit_at ON testing_audit(at DESC);

    CREATE TABLE IF NOT EXISTS testing_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  databaseInstance = db;
  ensureDefaultPolicy();
  return db;
}

function parseJson<T>(value: unknown): T | null {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function ensureDefaultPolicy() {
  const db = databaseInstance;
  if (!db) return;
  const count = db.prepare("SELECT COUNT(*) AS count FROM testing_policies").get() as { count?: number } | undefined;
  if ((count?.count ?? 0) > 0) return;
  db.prepare("INSERT INTO testing_policies(version, active, created_at, payload_json) VALUES (?, 1, ?, ?)").run(
    DEFAULT_TESTING_POLICY.version,
    DEFAULT_TESTING_POLICY.createdAt,
    JSON.stringify(DEFAULT_TESTING_POLICY)
  );
}

function canonicalEvidence(value: unknown, root = true): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalEvidence(item, false));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          !root ||
          ![
            "evidenceHash",
            "evidenceIntegrity",
            "notes",
            "evaluation",
            "quality",
            "validity",
            "flags",
            // Display names are derived from the versioned test catalog. IDs
            // remain signed, while a harmless catalog rename cannot make old
            // evidence look tampered with.
            "campaignName",
            "testCaseName"
          ].includes(key)
      )
      // Codepoint order, NOT localeCompare: a canonical tamper-detection hash
      // must not depend on the host's ICU/locale build. (For the current ASCII
      // evidence keys both orders are identical, so no stored hash changes.)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, canonicalEvidence(item, false)])
  );
}

/** Hashes only captured evidence. Mutable reviewer notes and policy replays
 * are deliberately excluded, so annotations never invalidate the recording. */
export function evidenceHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalEvidence(value)))
    .digest("hex");
}

export function saveTestingSession(session: TesterSessionSummary): void {
  const db = database();
  const language = session.browserLanguage.split(/[-_]/)[0] || "unknown";
  // Preserve the original value inside the hashed payload, but normalize the
  // index so current filters also find historical full-SHA captures.
  const indexedBuild = normalizeTestingBuildIdentity(session.gitCommit);
  db.prepare(
    `INSERT INTO testing_sessions(
      session_id, ended_at, tester_id, tester_key, build, test_case_id,
      platform, network_type, language, run_id, evidence_hash, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      ended_at=excluded.ended_at, tester_id=excluded.tester_id,
      tester_key=excluded.tester_key, build=excluded.build,
      test_case_id=excluded.test_case_id, platform=excluded.platform,
      network_type=excluded.network_type, language=excluded.language,
      run_id=excluded.run_id, evidence_hash=excluded.evidence_hash,
      payload_json=excluded.payload_json`
  ).run(
    session.sessionId,
    session.endedAt,
    session.testerId,
    session.testerKey,
    indexedBuild,
    session.testCaseId,
    session.platform,
    session.networkType,
    language,
    session.runId ?? null,
    session.evidenceHash,
    JSON.stringify(session)
  );
  if (session.assignmentId) completeAssignmentFromSession(session.assignmentId, session.sessionId, session.endedAt);
}

export function loadTestingSessions(limit: number): TesterSessionSummary[] {
  const rows = database()
    .prepare("SELECT payload_json FROM testing_sessions ORDER BY ended_at DESC LIMIT ?")
    .all(Math.max(1, Math.min(5_000, Math.round(limit)))) as Array<{ payload_json?: string }>;
  return rows
    .map((row) => parseJson<TesterSessionSummary>(row.payload_json))
    .filter((session): session is TesterSessionSummary => Boolean(session));
}

function safeSessionLimit(limit: number, fallback = 5_000): number {
  const value = Number.isFinite(limit) ? Math.round(limit) : fallback;
  return Math.max(1, Math.min(5_000, value));
}

function buildIdentityPredicate(build: string, exclude = false): { sql: string; parameters: string[] } {
  const normalizedBuild = normalizeTestingBuildIdentity(build, "").toLowerCase();
  const isGitCommit = /^[0-9a-f]{7,12}$/.test(normalizedBuild);
  if (!isGitCommit) {
    return {
      sql: exclude ? "LOWER(build) != ?" : "LOWER(build) = ?",
      parameters: [normalizedBuild]
    };
  }
  const legacyPrefixes = Array.from({ length: Math.max(0, normalizedBuild.length - 7) }, (_, index) =>
    normalizedBuild.slice(0, index + 7)
  );
  if (!legacyPrefixes.length) {
    return {
      sql: exclude ? "LOWER(build) NOT LIKE ?" : "LOWER(build) LIKE ?",
      parameters: [`${normalizedBuild}%`]
    };
  }
  const placeholders = legacyPrefixes.map(() => "?").join(", ");
  return {
    sql: exclude
      ? `LOWER(build) NOT IN (${placeholders}) AND LOWER(build) NOT LIKE ?`
      : `(LOWER(build) IN (${placeholders}) OR LOWER(build) LIKE ?)`,
    parameters: [...legacyPrefixes, `${normalizedBuild}%`]
  };
}

export function loadTestingSessionsForBuild(build: string, limit = 5_000): TesterSessionSummary[] {
  const predicate = buildIdentityPredicate(build);
  const rows = database()
    .prepare(
      `SELECT payload_json FROM testing_sessions WHERE ${predicate.sql} ORDER BY ended_at DESC, session_id DESC LIMIT ?`
    )
    .all(...predicate.parameters, safeSessionLimit(limit)) as Array<{ payload_json?: string }>;
  return rows
    .map((row) => parseJson<TesterSessionSummary>(row.payload_json))
    .filter((session): session is TesterSessionSummary => Boolean(session));
}

export function loadTestingSessionsExcludingBuild(build: string, limit = 5_000): TesterSessionSummary[] {
  const predicate = buildIdentityPredicate(build, true);
  const rows = database()
    .prepare(
      `SELECT payload_json FROM testing_sessions WHERE ${predicate.sql} ORDER BY ended_at DESC, session_id DESC LIMIT ?`
    )
    .all(...predicate.parameters, safeSessionLimit(limit)) as Array<{ payload_json?: string }>;
  return rows
    .map((row) => parseJson<TesterSessionSummary>(row.payload_json))
    .filter((session): session is TesterSessionSummary => Boolean(session));
}

function decodeSessionCursor(cursor: string | undefined): { endedAt: number; sessionId: string } | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (!isRecord(value) || typeof value.endedAt !== "number" || typeof value.sessionId !== "string") return null;
    return { endedAt: value.endedAt, sessionId: value.sessionId };
  } catch {
    return null;
  }
}

function encodeSessionCursor(session: TesterSessionSummary): string {
  return Buffer.from(JSON.stringify({ endedAt: session.endedAt, sessionId: session.sessionId })).toString("base64url");
}

/** Indexed, durable evidence query used by the HTTP paging API. */
export function storedTestingSessionPage(
  query: TestingSessionQuery = {},
  requesterTesterId?: string
): TestingSessionPage<TesterSessionSummary> {
  const where: string[] = [];
  const parameters: Array<string | number> = [];
  const testerId = cleanString(requesterTesterId ?? query.testerId, "", 80);
  if (testerId) {
    where.push("tester_id = ?");
    parameters.push(testerId);
  }
  if (query.testCaseId) {
    where.push("test_case_id = ?");
    parameters.push(query.testCaseId);
  }
  if (query.build) {
    const predicate = buildIdentityPredicate(query.build);
    where.push(predicate.sql);
    parameters.push(...predicate.parameters);
  }
  if (query.platform) {
    where.push("platform = ?");
    parameters.push(query.platform);
  }
  if (query.runId) {
    where.push("run_id = ?");
    parameters.push(query.runId);
  }
  if (query.quality) {
    where.push("json_extract(payload_json, '$.quality') = ?");
    parameters.push(query.quality);
  }
  const search = cleanString(query.search, "", 160).toLowerCase();
  if (search) {
    const escaped = search.replace(/[\\%_]/g, (character) => `\\${character}`);
    where.push("LOWER(payload_json) LIKE ? ESCAPE '\\'");
    parameters.push(`%${escaped}%`);
  }
  const baseWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const count = database()
    .prepare(`SELECT COUNT(*) AS count FROM testing_sessions ${baseWhere}`)
    .get(...parameters) as { count?: number } | undefined;

  const pageWhere = [...where];
  const pageParameters = [...parameters];
  const cursor = decodeSessionCursor(query.cursor);
  if (cursor) {
    pageWhere.push("(ended_at < ? OR (ended_at = ? AND session_id < ?))");
    pageParameters.push(cursor.endedAt, cursor.endedAt, cursor.sessionId);
  }
  const requestedLimit = typeof query.limit === "number" && Number.isFinite(query.limit) ? query.limit : 25;
  const limit = Math.max(1, Math.min(100, Math.round(requestedLimit)));
  const sqlWhere = pageWhere.length ? `WHERE ${pageWhere.join(" AND ")}` : "";
  const rows = database()
    .prepare(`SELECT payload_json FROM testing_sessions ${sqlWhere} ORDER BY ended_at DESC, session_id DESC LIMIT ?`)
    .all(...pageParameters, limit + 1) as Array<{ payload_json?: string }>;
  const hasMore = rows.length > limit;
  const items = rows
    .slice(0, limit)
    .map((row) => parseJson<TesterSessionSummary>(row.payload_json))
    .filter((session): session is TesterSessionSummary => Boolean(session))
    // Re-derive quality/validity against the current catalog so the durable
    // evidence page shows the SAME classification the release gate uses, not the
    // capture-time value frozen in the payload (which a later policy change
    // makes stale). The capture-time snapshot stays on captured*.
    .map(reevaluateStoredSession);
  return {
    items,
    total: Number(count?.count ?? 0),
    nextCursor: hasMore && items.length ? encodeSessionCursor(items[items.length - 1]) : undefined
  };
}

export function loadStoredTestingSession(sessionId: string): TesterSessionSummary | null {
  const row = database().prepare("SELECT payload_json FROM testing_sessions WHERE session_id = ?").get(sessionId) as
    | { payload_json?: string }
    | undefined;
  return parseJson<TesterSessionSummary>(row?.payload_json);
}

export function testingSessionCount(): number {
  const row = database().prepare("SELECT COUNT(*) AS count FROM testing_sessions").get() as
    | { count?: number }
    | undefined;
  return Number(row?.count ?? 0);
}

function revokeTestingSessionCredits(sessionIds: string[], now = Date.now()): void {
  if (!sessionIds.length) return;
  const removed = new Set(sessionIds);
  const rows = database().prepare("SELECT payload_json FROM testing_runs").all() as Array<{ payload_json?: string }>;
  const runs = rows
    .map((row) => parseJson<TestingRun>(row.payload_json))
    .filter((run): run is TestingRun => Boolean(run));
  let approvedBaseline = getApprovedBaselineBuild();

  for (const run of runs) {
    let revoked = 0;
    for (const assignment of run.assignments) {
      const retained = assignment.completedSessionIds.filter((sessionId) => !removed.has(sessionId));
      revoked += assignment.completedSessionIds.length - retained.length;
      if (retained.length === assignment.completedSessionIds.length) continue;
      assignment.completedSessionIds = retained;
      const requirement = run.requirements.find((item) => item.id === assignment.requirementId);
      assignment.status =
        requirement && retained.length >= requirement.requiredValidSessions
          ? "complete"
          : retained.length
            ? "in-progress"
            : "pending";
      assignment.updatedAt = now;
    }
    if (!revoked) continue;
    const coverageComplete = run.requirements.every((requirement) => {
      const captured = run.assignments
        .filter((assignment) => assignment.requirementId === requirement.id)
        .reduce((sum, assignment) => sum + assignment.completedSessionIds.length, 0);
      return captured >= requirement.requiredValidSessions;
    });
    if (!coverageComplete && (run.status === "ready" || run.status === "approved")) run.status = "blocked";
    run.updatedAt = now;
    saveRun(run);
    appendTestingAudit("system", "run.evidence-revoked", "run", run.id, {
      revokedSessions: revoked,
      coverageComplete,
      status: run.status
    });
    if (!coverageComplete && approvedBaseline === run.build) {
      database().prepare("DELETE FROM testing_settings WHERE key = 'approvedBaselineBuild'").run();
      appendTestingAudit("system", "baseline.revoked", "baseline", run.build, { runId: run.id });
      approvedBaseline = undefined;
    }
  }
}

export function deleteStoredTestingSession(sessionId: string): number {
  const db = database();
  db.exec("BEGIN IMMEDIATE");
  try {
    const changes = Number(db.prepare("DELETE FROM testing_sessions WHERE session_id = ?").run(sessionId).changes);
    if (changes) revokeTestingSessionCredits([sessionId]);
    db.exec("COMMIT");
    return changes;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function deleteStoredTesterSessions(testerKey: string): number {
  const db = database();
  db.exec("BEGIN IMMEDIATE");
  try {
    const rows = db.prepare("SELECT session_id FROM testing_sessions WHERE tester_key = ?").all(testerKey) as Array<{
      session_id?: string;
    }>;
    const sessionIds = rows.map((row) => row.session_id).filter((id): id is string => Boolean(id));
    const changes = Number(db.prepare("DELETE FROM testing_sessions WHERE tester_key = ?").run(testerKey).changes);
    revokeTestingSessionCredits(sessionIds);
    db.exec("COMMIT");
    return changes;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function deleteAllStoredTestingSessions(): number {
  const db = database();
  db.exec("BEGIN IMMEDIATE");
  try {
    const rows = db.prepare("SELECT session_id FROM testing_sessions").all() as Array<{ session_id?: string }>;
    const sessionIds = rows.map((row) => row.session_id).filter((id): id is string => Boolean(id));
    const changes = Number(db.prepare("DELETE FROM testing_sessions").run().changes);
    revokeTestingSessionCredits(sessionIds);
    db.exec("COMMIT");
    return changes;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function replaceStoredTestingSessions(sessions: TesterSessionSummary[]): void {
  const db = database();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM testing_sessions");
    for (const session of sessions) saveTestingSession(session);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function getActiveTestingPolicy(): TestingPolicy {
  const row = database()
    .prepare("SELECT payload_json FROM testing_policies WHERE active = 1 ORDER BY created_at DESC LIMIT 1")
    .get() as { payload_json?: string } | undefined;
  return clone(parseJson<TestingPolicy>(row?.payload_json) ?? DEFAULT_TESTING_POLICY);
}

export function listTestingPolicies(): TestingPolicy[] {
  const rows = database()
    .prepare("SELECT active, payload_json FROM testing_policies ORDER BY created_at DESC")
    .all() as Array<{ active?: number; payload_json?: string }>;
  return rows
    .map((row) => {
      const policy = parseJson<TestingPolicy>(row.payload_json);
      return policy ? { ...policy, active: row.active === 1 } : null;
    })
    .filter((item): item is TestingPolicy => Boolean(item));
}

export function createTestingPolicy(
  input: Partial<TestingPolicy> & { description?: string },
  actor: string,
  now = Date.now()
): TestingPolicy {
  const previous = getActiveTestingPolicy();
  const requestedVersion = cleanString(input.version, `${new Date(now).toISOString().slice(0, 10)}.${now}`, 80);
  const version = listTestingPolicies().some((policy) => policy.version === requestedVersion)
    ? `${requestedVersion.slice(0, 60)}.${now}`
    : requestedVersion;
  const releaseInput: Record<string, unknown> = isRecord(input.release) ? input.release : {};
  const regressionInput: Record<string, unknown> = isRecord(input.regression) ? input.regression : {};
  const bounded = (
    source: Record<string, unknown>,
    key: string,
    fallback: number,
    minimum: number,
    maximum: number
  ) => {
    const value = source[key];
    return typeof value === "number" && Number.isFinite(value)
      ? Math.min(maximum, Math.max(minimum, Math.round(value)))
      : fallback;
  };
  const requestedPlatforms = Array.isArray(releaseInput["requiredPlatforms"])
    ? releaseInput["requiredPlatforms"].filter(
        (platform: unknown): platform is TestingPlatform =>
          platform === "web" || platform === "ios" || platform === "android"
      )
    : previous.release.requiredPlatforms;
  const latencyWatchDeltaMs = bounded(
    regressionInput,
    "latencyWatchDeltaMs",
    previous.regression.latencyWatchDeltaMs,
    0,
    60_000
  );
  const scoreWatchDelta = bounded(regressionInput, "scoreWatchDelta", previous.regression.scoreWatchDelta, -100, 0);
  const policy: TestingPolicy = {
    ...previous,
    ...input,
    version,
    createdAt: now,
    createdBy: actor,
    description: cleanString(input.description, "Updated QA release policy.", 500),
    active: true,
    release: {
      maxFailSessions: bounded(releaseInput, "maxFailSessions", previous.release.maxFailSessions, 0, 10_000),
      maxWatchSessions: bounded(releaseInput, "maxWatchSessions", previous.release.maxWatchSessions, 0, 10_000),
      maxInvalidSessions: bounded(releaseInput, "maxInvalidSessions", previous.release.maxInvalidSessions, 0, 10_000),
      maxP95LatencyMs: bounded(releaseInput, "maxP95LatencyMs", previous.release.maxP95LatencyMs, 50, 60_000),
      minStandardSessions: bounded(releaseInput, "minStandardSessions", previous.release.minStandardSessions, 1, 100),
      minSafetyCriticalSessions: bounded(
        releaseInput,
        "minSafetyCriticalSessions",
        previous.release.minSafetyCriticalSessions,
        1,
        100
      ),
      requiredPlatforms: requestedPlatforms.length
        ? [...new Set(requestedPlatforms)]
        : [...previous.release.requiredPlatforms]
    },
    regression: {
      minimumMatchedCohortSessions: bounded(
        regressionInput,
        "minimumMatchedCohortSessions",
        previous.regression.minimumMatchedCohortSessions,
        1,
        100
      ),
      latencyWatchDeltaMs,
      latencyFailDeltaMs: Math.max(
        latencyWatchDeltaMs,
        bounded(regressionInput, "latencyFailDeltaMs", previous.regression.latencyFailDeltaMs, 0, 60_000)
      ),
      scoreWatchDelta,
      scoreFailDelta: Math.min(
        scoreWatchDelta,
        bounded(regressionInput, "scoreFailDelta", previous.regression.scoreFailDelta, -100, 0)
      )
    }
  };
  const db = database();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("UPDATE testing_policies SET active = 0");
    db.prepare("INSERT INTO testing_policies(version, active, created_at, payload_json) VALUES (?, 1, ?, ?)").run(
      policy.version,
      policy.createdAt,
      JSON.stringify(policy)
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  appendTestingAudit(actor, "policy.created", "policy", policy.version, { previousVersion: previous.version });
  return clone(policy);
}

function defaultRunRequirements(policy: TestingPolicy): TestingRunRequirement[] {
  return TESTING_TEST_CASES.flatMap((testCase) => {
    const requiredPlatforms = testCase.requiredPlatforms.filter((platform) =>
      policy.release.requiredPlatforms.includes(platform)
    );
    // A malformed/legacy policy must never erase a case's entire coverage.
    const platforms = requiredPlatforms.length ? requiredPlatforms : testCase.requiredPlatforms;
    const requiredSessions = Math.max(
      testCase.minimumValidSessions,
      testCase.risk === "safety-critical"
        ? policy.release.minSafetyCriticalSessions
        : policy.release.minStandardSessions
    );
    return platforms.map((platform) => ({
      id: `${testCase.id}:${platform}`,
      testCaseId: testCase.id,
      platform,
      networkType:
        testCase.id === "degraded-network-recovery"
          ? "degraded"
          : testCase.id === "wind-noise-robustness"
            ? "field"
            : "any",
      language: testCase.expectedLanguage,
      requiredValidSessions: Math.max(1, Math.ceil(requiredSessions / platforms.length))
    }));
  });
}

export function createTestingRun(
  input: { name?: unknown; build?: unknown; owner?: unknown; dueAt?: unknown; notes?: unknown },
  actor: string,
  currentBuild: string,
  now = Date.now()
): TestingRun {
  const policy = getActiveTestingPolicy();
  const id = randomUUID();
  const build = normalizeTestingBuildIdentity(input.build, normalizeTestingBuildIdentity(currentBuild));
  const run: TestingRun = {
    id,
    name: cleanString(input.name, `Release ${build}`, 120),
    build,
    status: "draft",
    owner: cleanString(input.owner, actor, 80),
    createdAt: now,
    updatedAt: now,
    dueAt: typeof input.dueAt === "number" && Number.isFinite(input.dueAt) ? Math.round(input.dueAt) : undefined,
    policyVersion: policy.version,
    requirements: defaultRunRequirements(policy),
    assignments: [],
    notes: cleanString(input.notes, "", 1_000)
  };
  saveRun(run);
  appendTestingAudit(actor, "run.created", "run", run.id, { build: run.build, requirements: run.requirements.length });
  return clone(run);
}

function saveRun(run: TestingRun): void {
  database()
    .prepare(
      `INSERT INTO testing_runs(id, build, status, updated_at, payload_json) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET build=excluded.build, status=excluded.status,
       updated_at=excluded.updated_at, payload_json=excluded.payload_json`
    )
    .run(run.id, run.build, run.status, run.updatedAt, JSON.stringify(run));
}

export function listTestingRuns(limit = 50): TestingRun[] {
  const rows = database()
    .prepare("SELECT payload_json FROM testing_runs ORDER BY updated_at DESC LIMIT ?")
    .all(Math.max(1, Math.min(200, Math.round(limit)))) as Array<{ payload_json?: string }>;
  return rows.map((row) => parseJson<TestingRun>(row.payload_json)).filter((item): item is TestingRun => Boolean(item));
}

export function getTestingRun(id: string): TestingRun | null {
  const row = database().prepare("SELECT payload_json FROM testing_runs WHERE id = ?").get(id) as
    | { payload_json?: string }
    | undefined;
  return parseJson<TestingRun>(row?.payload_json);
}

function getTestingRunForAssignment(assignmentId: string): TestingRun | null {
  const row = database()
    .prepare(
      `SELECT testing_runs.payload_json
       FROM testing_runs, json_each(testing_runs.payload_json, '$.assignments') AS assignment
       WHERE json_extract(assignment.value, '$.id') = ?
       LIMIT 1`
    )
    .get(assignmentId) as { payload_json?: string } | undefined;
  return parseJson<TestingRun>(row?.payload_json);
}

const RUN_STATUSES = new Set<TestingRunStatus>(["draft", "active", "blocked", "ready", "approved", "archived"]);

export function updateTestingRun(
  id: string,
  patch: { status?: unknown; owner?: unknown; dueAt?: unknown; notes?: unknown },
  actor: string,
  now = Date.now()
): TestingRun | null {
  const run = getTestingRun(id);
  if (!run) return null;
  const previousStatus = run.status;
  if (typeof patch.status === "string" && RUN_STATUSES.has(patch.status as TestingRunStatus)) {
    const requestedStatus = patch.status as TestingRunStatus;
    if (previousStatus !== "archived" && (previousStatus !== "approved" || requestedStatus === "archived")) {
      run.status = requestedStatus;
    }
  }
  if (patch.owner !== undefined) run.owner = cleanString(patch.owner, run.owner, 80);
  if (patch.notes !== undefined) run.notes = cleanString(patch.notes, "", 1_000);
  if (patch.dueAt === null) delete run.dueAt;
  else if (typeof patch.dueAt === "number" && Number.isFinite(patch.dueAt)) run.dueAt = Math.round(patch.dueAt);
  run.updatedAt = now;
  if (run.status === "approved" && previousStatus !== "approved") {
    run.approvedAt = now;
    run.approvedBy = actor;
    setApprovedBaselineBuild(run.build, actor, now);
  }
  saveRun(run);
  appendTestingAudit(actor, "run.updated", "run", run.id, { status: run.status, owner: run.owner });
  return clone(run);
}

export function createTestingAssignment(
  runId: string,
  input: { requirementId?: unknown; assignee?: unknown },
  actor: string,
  now = Date.now()
): TestingRun | null {
  const run = getTestingRun(runId);
  if (!run || run.status === "approved" || run.status === "archived") return null;
  const requirementId = cleanString(input.requirementId, "", 160);
  const requirement = run.requirements.find((item) => item.id === requirementId);
  if (!requirement) return null;
  const assignment: TestingAssignment = {
    id: randomUUID(),
    runId,
    requirementId: requirement.id,
    testCaseId: requirement.testCaseId,
    assignee: cleanString(input.assignee, actor, 80),
    platform: requirement.platform,
    networkType: requirement.networkType,
    language: requirement.language,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    completedSessionIds: []
  };
  run.assignments.push(assignment);
  run.updatedAt = now;
  saveRun(run);
  appendTestingAudit(actor, "assignment.created", "assignment", assignment.id, {
    runId,
    requirementId,
    assignee: assignment.assignee
  });
  return clone(run);
}

export function updateTestingAssignment(
  runId: string,
  assignmentId: string,
  patch: { status?: unknown; assignee?: unknown },
  actor: string,
  now = Date.now()
): TestingRun | null {
  const run = getTestingRun(runId);
  const assignment = run?.assignments.find((item) => item.id === assignmentId);
  if (!run || !assignment || run.status === "approved" || run.status === "archived") return null;
  const statuses = new Set(["pending", "in-progress", "complete", "blocked"]);
  if (typeof patch.status === "string" && statuses.has(patch.status)) {
    assignment.status = patch.status as TestingAssignment["status"];
  }
  let clearedEvidence = 0;
  if (patch.assignee !== undefined) {
    const nextAssignee = cleanString(patch.assignee, assignment.assignee, 80);
    if (nextAssignee !== assignment.assignee) {
      assignment.assignee = nextAssignee;
      clearedEvidence = assignment.completedSessionIds.length;
      assignment.completedSessionIds = [];
      assignment.status = "pending";
      if (run.status === "ready") run.status = "active";
    }
  }
  assignment.updatedAt = now;
  run.updatedAt = now;
  saveRun(run);
  appendTestingAudit(actor, "assignment.updated", "assignment", assignment.id, {
    runId,
    status: assignment.status,
    assignee: assignment.assignee,
    clearedEvidence
  });
  return clone(run);
}

function completeAssignmentFromSession(assignmentId: string, sessionId: string, now: number): void {
  const run = getTestingRunForAssignment(assignmentId);
  const assignment = run?.assignments.find((item) => item.id === assignmentId);
  if (!run || !assignment || run.status === "approved" || run.status === "archived") return;
  const session = database()
    .prepare("SELECT payload_json FROM testing_sessions WHERE session_id = ?")
    .get(sessionId) as { payload_json?: string } | undefined;
  const stored = parseJson<TesterSessionSummary>(session?.payload_json);
  const requirement = run.requirements.find((item) => item.id === assignment.requirementId);
  if (!stored || !requirement || stored.runId !== run.id) return;
  // Credit on the CURRENT-catalog validity (matching the release gate), not the
  // capture-time capturedValidity frozen in the payload — otherwise a run can be
  // marked "ready" on evidence the gate now excludes.
  const evidence = reevaluateStoredSession(stored);
  const language = evidence.browserLanguage.toLowerCase().split(/[-_]/)[0];
  const network = evidence.networkType.toLowerCase();
  const networkMatches =
    requirement.networkType === "any" ||
    network.includes(requirement.networkType.toLowerCase()) ||
    (requirement.networkType === "degraded" && /poor|loss|weak|2g|3g/.test(network));
  const evidenceMatches =
    evidence.testerId === assignment.assignee &&
    evidence.testCaseId === assignment.testCaseId &&
    testingBuildsMatch(evidence.gitCommit, run.build) &&
    evidence.validity.status === "valid" &&
    evidence.evidenceIntegrity !== "mismatch" &&
    (assignment.platform === "unknown" || evidence.platform === assignment.platform) &&
    (requirement.language === "any" || language === requirement.language) &&
    networkMatches;
  if (!evidenceMatches) return;
  const newlyCredited = !assignment.completedSessionIds.includes(sessionId);
  if (newlyCredited) assignment.completedSessionIds.push(sessionId);
  assignment.status =
    assignment.completedSessionIds.length >= requirement.requiredValidSessions ? "complete" : "in-progress";
  assignment.updatedAt = now;
  run.updatedAt = now;
  const ready = run.requirements.every((item) => {
    const captured = run.assignments
      .filter((candidate) => candidate.requirementId === item.id)
      .reduce((sum, candidate) => sum + candidate.completedSessionIds.length, 0);
    return captured >= item.requiredValidSessions;
  });
  const becameReady = ready && (run.status === "draft" || run.status === "active" || run.status === "blocked");
  if (becameReady) run.status = "ready";
  saveRun(run);
  if (newlyCredited) {
    appendTestingAudit("system", "assignment.evidence-credited", "assignment", assignment.id, {
      runId: run.id,
      sessionId,
      completed: assignment.completedSessionIds.length,
      required: requirement.requiredValidSessions
    });
  }
  if (becameReady) {
    appendTestingAudit("system", "run.ready", "run", run.id, { build: run.build });
  }
}

const REVIEW_STATUSES = new Set<TestingReviewStatus>(["open", "triaged", "resolved", "waived"]);
const REVIEW_SEVERITIES = new Set<TestingReviewSeverity>(["low", "medium", "high", "critical"]);

export function upsertTestingReview(
  input: {
    id?: unknown;
    sessionId?: unknown;
    runId?: unknown;
    status?: unknown;
    severity?: unknown;
    owner?: unknown;
    title?: unknown;
    comment?: unknown;
    resolution?: unknown;
  },
  actor: string,
  now = Date.now()
): TestingReview | null {
  const sessionId = cleanString(input.sessionId, "", 120);
  if (!sessionId) return null;
  const requestedId = cleanString(input.id, "", 80);
  // Look the target up with an indexed query, not a capped in-memory scan: with
  // more than ~500 reviews, an older-but-open review (or an update-by-id for an
  // old review) fell outside listTestingReviews' window and silently minted a
  // duplicate instead of updating in place.
  const findReviewRow = (sql: string, param: string): TestingReview | null => {
    const row = database().prepare(sql).get(param) as { payload_json?: string } | undefined;
    return row ? parseJson<TestingReview>(row.payload_json) : null;
  };
  const existing = requestedId
    ? findReviewRow("SELECT payload_json FROM testing_reviews WHERE id = ?", requestedId)
    : findReviewRow(
        "SELECT payload_json FROM testing_reviews WHERE session_id = ? AND status IN ('open', 'triaged') " +
          "ORDER BY updated_at DESC LIMIT 1",
        sessionId
      );
  const status =
    typeof input.status === "string" && REVIEW_STATUSES.has(input.status as TestingReviewStatus)
      ? (input.status as TestingReviewStatus)
      : (existing?.status ?? "open");
  const severity =
    typeof input.severity === "string" && REVIEW_SEVERITIES.has(input.severity as TestingReviewSeverity)
      ? (input.severity as TestingReviewSeverity)
      : (existing?.severity ?? "medium");
  const review: TestingReview = {
    id: existing?.id ?? randomUUID(),
    sessionId,
    runId: cleanString(input.runId, existing?.runId ?? "", 80) || undefined,
    status,
    severity,
    owner: cleanString(input.owner, existing?.owner ?? actor, 80),
    title: cleanString(input.title, existing?.title ?? "Session requires review", 160),
    comment: cleanString(input.comment, existing?.comment ?? "", 2_000),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    createdBy: existing?.createdBy ?? actor,
    resolvedBy: status === "resolved" || status === "waived" ? actor : undefined,
    resolution:
      status === "resolved" || status === "waived"
        ? cleanString(input.resolution, existing?.resolution ?? "Reviewed", 1_000)
        : undefined
  };
  database()
    .prepare(
      `INSERT INTO testing_reviews(id, session_id, status, severity, updated_at, payload_json) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, status=excluded.status,
       severity=excluded.severity, updated_at=excluded.updated_at, payload_json=excluded.payload_json`
    )
    .run(review.id, review.sessionId, review.status, review.severity, review.updatedAt, JSON.stringify(review));
  appendTestingAudit(actor, existing ? "review.updated" : "review.created", "review", review.id, {
    sessionId,
    status,
    severity,
    owner: review.owner
  });
  return clone(review);
}

export function listTestingReviews(limit = 200): TestingReview[] {
  const rows = database()
    .prepare("SELECT payload_json FROM testing_reviews ORDER BY updated_at DESC LIMIT ?")
    .all(Math.max(1, Math.min(1_000, Math.round(limit)))) as Array<{ payload_json?: string }>;
  return rows
    .map((row) => parseJson<TestingReview>(row.payload_json))
    .filter((item): item is TestingReview => Boolean(item));
}

export function appendTestingAudit(
  actor: string,
  action: string,
  targetType: TestingAuditEvent["targetType"],
  targetId: string,
  detail: Record<string, unknown> = {},
  now = Date.now()
): TestingAuditEvent {
  const event: TestingAuditEvent = {
    id: randomUUID(),
    at: now,
    actor: cleanString(actor, "system", 80),
    action: cleanString(action, "unknown", 120),
    targetType,
    targetId: cleanString(targetId, "unknown", 160),
    detail: clone(detail)
  };
  database()
    .prepare(
      "INSERT INTO testing_audit(id, at, actor, action, target_type, target_id, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(event.id, event.at, event.actor, event.action, event.targetType, event.targetId, JSON.stringify(event.detail));
  return event;
}

export function listTestingAudit(limit = 100): TestingAuditEvent[] {
  const rows = database()
    .prepare(
      "SELECT id, at, actor, action, target_type, target_id, detail_json FROM testing_audit ORDER BY at DESC LIMIT ?"
    )
    .all(Math.max(1, Math.min(500, Math.round(limit)))) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    at: Number(row.at),
    actor: String(row.actor),
    action: String(row.action),
    targetType: row.target_type as TestingAuditEvent["targetType"],
    targetId: String(row.target_id),
    detail: parseJson<Record<string, unknown>>(row.detail_json) ?? {}
  }));
}

export function getApprovedBaselineBuild(): string | undefined {
  const row = database().prepare("SELECT value FROM testing_settings WHERE key = 'approvedBaselineBuild'").get() as
    | { value?: string }
    | undefined;
  return cleanString(row?.value, "", 80) || undefined;
}

export function setApprovedBaselineBuild(build: string, actor: string, now = Date.now()): string {
  const cleanBuild = cleanString(build, "", 80);
  if (!cleanBuild) throw new Error("A baseline build is required");
  database()
    .prepare(
      "INSERT INTO testing_settings(key, value) VALUES ('approvedBaselineBuild', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    )
    .run(cleanBuild);
  appendTestingAudit(actor, "baseline.approved", "baseline", cleanBuild, {}, now);
  return cleanBuild;
}

export function testingOperationsSnapshot(): TestingOperationsSnapshot {
  return {
    activePolicy: getActiveTestingPolicy(),
    approvedBaselineBuild: getApprovedBaselineBuild(),
    runs: listTestingRuns(),
    reviews: listTestingReviews(),
    audit: listTestingAudit()
  };
}

export function inferTestingPlatform(value: unknown, deviceLabel?: string, networkType?: string): TestingPlatform {
  if (value === "web" || value === "ios" || value === "android") return value;
  const haystack = `${String(deviceLabel ?? "")} ${String(networkType ?? "")}`.toLowerCase();
  if (haystack.includes("ios") || haystack.includes("iphone") || haystack.includes("ipad")) return "ios";
  if (haystack.includes("android")) return "android";
  if (haystack.includes("browser") || haystack.includes("web")) return "web";
  return "unknown";
}

/** Test-only reset. Production never destroys the database implicitly. */
export function resetTestingStore(): void {
  const db = database();
  db.exec(`
    DELETE FROM testing_sessions;
    DELETE FROM testing_runs;
    DELETE FROM testing_reviews;
    DELETE FROM testing_audit;
    DELETE FROM testing_settings;
    DELETE FROM testing_policies;
  `);
  ensureDefaultPolicy();
}

export function closeTestingStoreForTests(): void {
  try {
    databaseInstance?.close();
  } catch (error) {
    log.warn("testing database close failed", { message: error instanceof Error ? error.message : String(error) });
  }
  databaseInstance = null;
}
