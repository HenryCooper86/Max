import type { TesterSessionSummary, TestingStats } from "../../shared/agent";
import type {
  TestingAuditEvent,
  TestingOperationsSnapshot,
  TestingPolicy,
  TestingReview,
  TestingRun,
  TestingSessionPage,
  TestingSessionQuery
} from "../../shared/testing";
import { credentialToken } from "./utils";

type ApiResult<T> = { ok: true } & T;

function headers(json = false): Record<string, string> {
  const token = credentialToken();
  return {
    ...(json ? { "Content-Type": "application/json" } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

async function request<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const response = await fetch(path, init);
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export async function fetchTestingSummary(): Promise<TestingStats | null> {
  const payload = await request<ApiResult<{ testing: TestingStats }>>("/testing/summary", { headers: headers() });
  return payload?.ok ? payload.testing : null;
}

export async function fetchTestingSessions(
  query: TestingSessionQuery = {}
): Promise<TestingSessionPage<TesterSessionSummary> | null> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const suffix = params.size ? `?${params.toString()}` : "";
  const payload = await request<ApiResult<TestingSessionPage<TesterSessionSummary>>>(`/testing/sessions${suffix}`, {
    headers: headers()
  });
  return payload?.ok ? { items: payload.items, nextCursor: payload.nextCursor, total: payload.total } : null;
}

export async function fetchTestingSession(sessionId: string): Promise<TesterSessionSummary | null> {
  const payload = await request<ApiResult<{ session: TesterSessionSummary }>>(
    `/testing/sessions/${encodeURIComponent(sessionId)}`,
    { headers: headers() }
  );
  return payload?.ok ? payload.session : null;
}

export async function updateTestingSessionNotes(
  sessionId: string,
  notes: string
): Promise<TesterSessionSummary | null> {
  const payload = await request<ApiResult<{ session: TesterSessionSummary }>>(
    `/testing/sessions/${encodeURIComponent(sessionId)}/notes`,
    { method: "POST", headers: headers(true), body: JSON.stringify({ notes }) }
  );
  return payload?.ok ? payload.session : null;
}

export async function fetchTestingOperations(): Promise<{
  operations: TestingOperationsSnapshot;
  policies: TestingPolicy[];
} | null> {
  const payload = await request<ApiResult<{ operations: TestingOperationsSnapshot; policies: TestingPolicy[] }>>(
    "/testing/operations",
    { headers: headers() }
  );
  return payload?.ok ? { operations: payload.operations, policies: payload.policies } : null;
}

export async function fetchTestingRuns(): Promise<TestingRun[] | null> {
  const payload = await request<ApiResult<{ runs: TestingRun[] }>>("/testing/runs", { headers: headers() });
  return payload?.ok ? payload.runs : null;
}

export async function createTestingRun(input: {
  name: string;
  build: string;
  owner: string;
  dueAt?: number;
  notes?: string;
}): Promise<TestingRun | null> {
  const payload = await request<ApiResult<{ run: TestingRun }>>("/testing/runs", {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify(input)
  });
  return payload?.ok ? payload.run : null;
}

export async function updateTestingRun(
  runId: string,
  patch: Partial<Pick<TestingRun, "status" | "owner" | "dueAt" | "notes">>
): Promise<TestingRun | null> {
  const payload = await request<ApiResult<{ run: TestingRun }>>(`/testing/runs/${encodeURIComponent(runId)}`, {
    method: "PATCH",
    headers: headers(true),
    body: JSON.stringify(patch)
  });
  return payload?.ok ? payload.run : null;
}

export async function createTestingAssignment(
  runId: string,
  requirementId: string,
  assignee: string
): Promise<TestingRun | null> {
  const payload = await request<ApiResult<{ run: TestingRun }>>(
    `/testing/runs/${encodeURIComponent(runId)}/assignments`,
    {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify({ requirementId, assignee })
    }
  );
  return payload?.ok ? payload.run : null;
}

export async function updateTestingAssignment(
  runId: string,
  assignmentId: string,
  patch: { status?: string; assignee?: string }
): Promise<TestingRun | null> {
  const payload = await request<ApiResult<{ run: TestingRun }>>(
    `/testing/runs/${encodeURIComponent(runId)}/assignments/${encodeURIComponent(assignmentId)}`,
    { method: "PATCH", headers: headers(true), body: JSON.stringify(patch) }
  );
  return payload?.ok ? payload.run : null;
}

export async function saveTestingReview(
  input: Partial<TestingReview> & { sessionId: string }
): Promise<TestingReview | null> {
  const payload = await request<ApiResult<{ review: TestingReview }>>("/testing/reviews", {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify(input)
  });
  return payload?.ok ? payload.review : null;
}

export async function createTestingPolicy(input: Partial<TestingPolicy>): Promise<TestingPolicy | null> {
  const payload = await request<ApiResult<{ policy: TestingPolicy }>>("/testing/policies", {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify(input)
  });
  return payload?.ok ? payload.policy : null;
}

export async function fetchTestingAudit(): Promise<TestingAuditEvent[] | null> {
  const payload = await request<ApiResult<{ events: TestingAuditEvent[] }>>("/testing/audit", {
    headers: headers()
  });
  return payload?.ok ? payload.events : null;
}
