import type { TesterSessionSummary, TestingStats } from "../../shared/agent";
import type {
  TestingOperationsSnapshot,
  TestingPolicy,
  TestingReview,
  TestingRun,
  TestingSessionPage,
  TestingSessionQuery
} from "../../shared/testing";
import { requestJson, type ApiResult } from "./api-client";
import { credentialToken } from "./utils";

function headers(json = false): Record<string, string> {
  const token = credentialToken();
  return {
    ...(json ? { "Content-Type": "application/json" } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

export type TestingClearScope =
  { scope: "all" } | { scope: "tester"; testerKey: string } | { scope: "session"; sessionId: string };
type TestingClearResult = { removedTesters: number; removedSessions: number };

export type TestingApi = {
  fetchSummary: () => Promise<ApiResult<TestingStats>>;
  fetchSessions: (query?: TestingSessionQuery) => Promise<ApiResult<TestingSessionPage<TesterSessionSummary>>>;
  fetchSession: (sessionId: string) => Promise<ApiResult<TesterSessionSummary>>;
  updateSessionNotes: (sessionId: string, notes: string) => Promise<ApiResult<TesterSessionSummary>>;
  fetchOperations: () => Promise<ApiResult<{ operations: TestingOperationsSnapshot; policies: TestingPolicy[] }>>;
  fetchRuns: () => Promise<ApiResult<TestingRun[]>>;
  createRun: (input: {
    name: string;
    build: string;
    owner: string;
    dueAt?: number;
    notes?: string;
  }) => Promise<ApiResult<TestingRun>>;
  updateRun: (
    runId: string,
    patch: Partial<Pick<TestingRun, "status" | "owner" | "dueAt" | "notes">>
  ) => Promise<ApiResult<TestingRun>>;
  createAssignment: (runId: string, requirementId: string, assignee: string) => Promise<ApiResult<TestingRun>>;
  saveReview: (input: Partial<TestingReview> & { sessionId: string }) => Promise<ApiResult<TestingReview>>;
  createPolicy: (input: Partial<TestingPolicy>) => Promise<ApiResult<TestingPolicy>>;
  clear: (payload: TestingClearScope) => Promise<ApiResult<TestingClearResult>>;
};

export type CreateTestingRunInput = Parameters<TestingApi["createRun"]>[0];
export type UpdateTestingRunPatch = Parameters<TestingApi["updateRun"]>[1];

async function fetchSummary(): Promise<ApiResult<TestingStats>> {
  const result = await requestJson<{ ok: true; testing: TestingStats }>("/testing/summary", { headers: headers() });
  return result.ok ? { ok: true, data: result.data.testing } : result;
}

async function fetchSessions(
  query: TestingSessionQuery = {}
): Promise<ApiResult<TestingSessionPage<TesterSessionSummary>>> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const suffix = params.size ? `?${params.toString()}` : "";
  const result = await requestJson<{ ok: true } & TestingSessionPage<TesterSessionSummary>>(
    `/testing/sessions${suffix}`,
    {
      headers: headers()
    }
  );
  return result.ok
    ? { ok: true, data: { items: result.data.items, nextCursor: result.data.nextCursor, total: result.data.total } }
    : result;
}

async function fetchSession(sessionId: string): Promise<ApiResult<TesterSessionSummary>> {
  const result = await requestJson<{ ok: true; session: TesterSessionSummary }>(
    `/testing/sessions/${encodeURIComponent(sessionId)}`,
    { headers: headers() }
  );
  return result.ok ? { ok: true, data: result.data.session } : result;
}

async function updateSessionNotes(sessionId: string, notes: string): Promise<ApiResult<TesterSessionSummary>> {
  const result = await requestJson<{ ok: true; session: TesterSessionSummary }>(
    `/testing/sessions/${encodeURIComponent(sessionId)}/notes`,
    { method: "POST", headers: headers(true), body: JSON.stringify({ notes }) }
  );
  return result.ok ? { ok: true, data: result.data.session } : result;
}

async function fetchOperations(): Promise<
  ApiResult<{ operations: TestingOperationsSnapshot; policies: TestingPolicy[] }>
> {
  const result = await requestJson<{ ok: true; operations: TestingOperationsSnapshot; policies: TestingPolicy[] }>(
    "/testing/operations",
    { headers: headers() }
  );
  return result.ok
    ? { ok: true, data: { operations: result.data.operations, policies: result.data.policies } }
    : result;
}

async function fetchRuns(): Promise<ApiResult<TestingRun[]>> {
  const result = await requestJson<{ ok: true; runs: TestingRun[] }>("/testing/runs", { headers: headers() });
  return result.ok ? { ok: true, data: result.data.runs } : result;
}

async function createRun(input: CreateTestingRunInput): Promise<ApiResult<TestingRun>> {
  const result = await requestJson<{ ok: true; run: TestingRun }>("/testing/runs", {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify(input)
  });
  return result.ok ? { ok: true, data: result.data.run } : result;
}

async function updateRun(runId: string, patch: UpdateTestingRunPatch): Promise<ApiResult<TestingRun>> {
  const result = await requestJson<{ ok: true; run: TestingRun }>(`/testing/runs/${encodeURIComponent(runId)}`, {
    method: "PATCH",
    headers: headers(true),
    body: JSON.stringify(patch)
  });
  return result.ok ? { ok: true, data: result.data.run } : result;
}

async function createAssignment(
  runId: string,
  requirementId: string,
  assignee: string
): Promise<ApiResult<TestingRun>> {
  const result = await requestJson<{ ok: true; run: TestingRun }>(
    `/testing/runs/${encodeURIComponent(runId)}/assignments`,
    { method: "POST", headers: headers(true), body: JSON.stringify({ requirementId, assignee }) }
  );
  return result.ok ? { ok: true, data: result.data.run } : result;
}

async function saveReview(input: Partial<TestingReview> & { sessionId: string }): Promise<ApiResult<TestingReview>> {
  const result = await requestJson<{ ok: true; review: TestingReview }>("/testing/reviews", {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify(input)
  });
  return result.ok ? { ok: true, data: result.data.review } : result;
}

async function createPolicy(input: Partial<TestingPolicy>): Promise<ApiResult<TestingPolicy>> {
  const result = await requestJson<{ ok: true; policy: TestingPolicy }>("/testing/policies", {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify(input)
  });
  return result.ok ? { ok: true, data: result.data.policy } : result;
}

async function clear(payload: TestingClearScope): Promise<ApiResult<TestingClearResult>> {
  const result = await requestJson<{ ok: true } & TestingClearResult>("/testing/clear", {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify(payload)
  });
  return result.ok
    ? { ok: true, data: { removedTesters: result.data.removedTesters, removedSessions: result.data.removedSessions } }
    : result;
}

export const testingApi: TestingApi = {
  fetchSummary,
  fetchSessions,
  fetchSession,
  updateSessionNotes,
  fetchOperations,
  fetchRuns,
  createRun,
  updateRun,
  createAssignment,
  saveReview,
  createPolicy,
  clear
};
