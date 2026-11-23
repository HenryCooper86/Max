import type { DatabaseSync } from "node:sqlite";
import {
  isReplayToolName,
  REPLAY_LIMITS,
  type ReplayCase,
  type ReplayCheck,
  type ReplayCheckOutcome
} from "../../shared/studio-replay";
import type { Result } from "./customers";
import { newId } from "./secrets";
import { immediate, liveProject } from "./store";

type CaseRow = Omit<ReplayCase, "fixtures"> & { fixtures: string };
type CaseData = Omit<CaseRow, "id" | "version">;

const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);
const fail = (status: number, error: string) => ({ ok: false, status, error }) as const;

function withProject<T>(customerId: string, projectId: string, work: (db: DatabaseSync) => Result<T>): Result<T> {
  return immediate((db) => {
    if (!liveProject(projectId, customerId)) return fail(404, "Project not found.");
    return work(db);
  });
}

function validatedCase(body: Record<string, unknown>): Result<CaseData> {
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const expected = typeof body.expected === "string" ? body.expected.trim() : "";
  if (!prompt || prompt.length > REPLAY_LIMITS.prompt)
    return fail(400, `Enter a test prompt of up to ${REPLAY_LIMITS.prompt} characters.`);
  if (!expected || expected.length > REPLAY_LIMITS.expected)
    return fail(400, `Enter an expected result of up to ${REPLAY_LIMITS.expected} characters.`);
  const fixtures = body.fixtures;
  if (!fixtures || typeof fixtures !== "object" || Array.isArray(fixtures))
    return fail(400, "Tool responses must be a JSON object keyed by tool name.");
  const names = Object.keys(fixtures);
  if (names.length > REPLAY_LIMITS.fixtures || names.some((name) => !isReplayToolName(name)))
    return fail(400, `Provide up to ${REPLAY_LIMITS.fixtures} simulated responses with valid tool names.`);
  try {
    const json = JSON.stringify(fixtures, (key, value: unknown) => {
      if (
        unsafeKeys.has(key) ||
        !(
          value === null ||
          typeof value === "object" ||
          typeof value === "string" ||
          typeof value === "boolean" ||
          (typeof value === "number" && Number.isFinite(value))
        )
      ) {
        throw new Error("Invalid JSON response.");
      }
      return value;
    });
    if (!json.startsWith("{")) return fail(400, "Tool responses must be a JSON object keyed by tool name.");
    if (Buffer.byteLength(json) > REPLAY_LIMITS.fixtureBytes)
      return fail(400, `Simulated tool responses must fit within ${REPLAY_LIMITS.fixtureBytes} bytes.`);
    return { ok: true, value: { prompt, expected, fixtures: json } };
  } catch {
    return fail(400, "Simulated tool responses must contain valid JSON.");
  }
}

function replayCase(row: CaseRow): ReplayCase {
  return { ...row, fixtures: JSON.parse(row.fixtures) as ReplayCase["fixtures"] };
}

function currentCase(db: DatabaseSync, projectId: string, id: string, version: unknown): Result<CaseRow> {
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1)
    return fail(400, "A test case version is required.");
  const row = db
    .prepare("SELECT id, version, prompt, expected, fixtures FROM studio_replay_cases WHERE project_id = ? AND id = ?")
    .get(projectId, id) as CaseRow | undefined;
  if (!row) return fail(404, "Test case not found.");
  if (row.version !== version) return fail(409, "This test case has changed. Reload it and try again.");
  return { ok: true, value: row };
}

export function listReplayCases(customerId: string, projectId: string): Result<{ cases: ReplayCase[] }> {
  return withProject(customerId, projectId, (db) => {
    const rows = db
      .prepare(
        "SELECT id, version, prompt, expected, fixtures FROM studio_replay_cases WHERE project_id = ? ORDER BY rowid"
      )
      .all(projectId) as CaseRow[];
    return { ok: true, value: { cases: rows.map(replayCase) } };
  });
}

export function createReplayCase(
  customerId: string,
  projectId: string,
  body: Record<string, unknown>
): Result<{ testCase: ReplayCase }> {
  return withProject(customerId, projectId, (db) => {
    const data = validatedCase(body);
    if (!data.ok) return data;
    const { count } = db
      .prepare("SELECT COUNT(*) AS count FROM studio_replay_cases WHERE project_id = ?")
      .get(projectId) as {
      count: number;
    };
    if (count >= REPLAY_LIMITS.cases) return fail(409, `A project can have up to ${REPLAY_LIMITS.cases} test cases.`);
    const row = { ...data.value, id: newId("case_"), version: 1 };
    db.prepare(
      "INSERT INTO studio_replay_cases (project_id, id, version, prompt, expected, fixtures) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(projectId, row.id, row.version, row.prompt, row.expected, row.fixtures);
    return { ok: true, value: { testCase: replayCase(row) } };
  });
}

export function updateReplayCase(
  customerId: string,
  projectId: string,
  id: string,
  body: Record<string, unknown>
): Result<{ testCase: ReplayCase }> {
  return withProject(customerId, projectId, (db) => {
    const current = currentCase(db, projectId, id, body.version);
    if (!current.ok) return current;
    const data = validatedCase(body);
    if (!data.ok) return data;
    const row = { ...data.value, id, version: current.value.version + 1 };
    db.prepare(
      "UPDATE studio_replay_cases SET version = ?, prompt = ?, expected = ?, fixtures = ? WHERE project_id = ? AND id = ?"
    ).run(row.version, row.prompt, row.expected, row.fixtures, projectId, id);
    return { ok: true, value: { testCase: replayCase(row) } };
  });
}

export function deleteReplayCase(
  customerId: string,
  projectId: string,
  id: string,
  version: unknown
): Result<{ ok: true }> {
  return withProject(customerId, projectId, (db) => {
    const current = currentCase(db, projectId, id, version);
    if (!current.ok) return current;
    db.prepare("DELETE FROM studio_replay_cases WHERE project_id = ? AND id = ?").run(projectId, id);
    return { ok: true, value: { ok: true } };
  });
}

export function readReplayCase(
  customerId: string,
  projectId: string,
  id: string,
  version: unknown
): Result<{ testCase: ReplayCase }> {
  return withProject(customerId, projectId, (db) => {
    const current = currentCase(db, projectId, id, version);
    if (!current.ok) return current;
    return { ok: true, value: { testCase: replayCase(current.value) } };
  });
}

/** Only current answers leave the store. A change to either target makes the case due for another run. */
export function draftReplayChecks(db: DatabaseSync, projectId: string, revision: string): ReplayCheck[] {
  const rows = db
    .prepare(
      `SELECT c.id, c.version, c.prompt, c.expected, r.revision AS lastRevision,
    CASE WHEN r.revision=? AND r.version=c.version THEN r.outcome END AS outcome
    FROM studio_replay_cases c LEFT JOIN studio_replay_results r ON c.project_id=r.project_id AND c.id=r.id
    WHERE c.project_id=? ORDER BY c.rowid`
    )
    .all(revision, projectId) as (Pick<ReplayCase, "id" | "version" | "prompt" | "expected"> & {
    lastRevision: string | null;
    outcome: string | null;
  })[];
  return rows.map(({ lastRevision, outcome, ...item }) => ({
    ...item,
    stale: lastRevision !== null && outcome === null,
    outcome: outcome === null ? null : (JSON.parse(outcome) as ReplayCheckOutcome)
  }));
}

export function recordReplayOutcome(
  customerId: string,
  projectId: string,
  revision: string,
  testCase: ReplayCase,
  outcome: ReplayCheckOutcome
): Result<true> {
  return withProject(customerId, projectId, (db) => {
    const latest = currentCase(db, projectId, testCase.id, testCase.version);
    if (!latest.ok) return latest;
    if (
      !db
        .prepare("SELECT 1 FROM studio_snapshots WHERE project_id=? AND role='draft' AND revision=?")
        .get(projectId, revision)
    )
      return fail(409, "The draft changed. Refresh and replay the current draft.");
    db.prepare(
      `INSERT INTO studio_replay_results(project_id,id,revision,version,outcome) VALUES (?,?,?,?,?)
      ON CONFLICT(project_id,id) DO UPDATE SET revision=excluded.revision,version=excluded.version,outcome=excluded.outcome`
    ).run(projectId, testCase.id, revision, testCase.version, JSON.stringify(outcome));
    return { ok: true, value: true };
  });
}
