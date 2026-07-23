import { useCallback, useEffect, useRef, useState } from "react";
import type { TesterSessionSummary, TestingStats } from "../../../shared/agent";
import type { TestingOperationsSnapshot, TestingPolicy, TestingReview, TestingRun } from "../../../shared/testing";
import type { ApiError, ApiResult } from "../../lib/api-client";
import type { AuthUser } from "../../lib/auth";
import { testingApi, type CreateTestingRunInput, type UpdateTestingRunPatch } from "../../lib/testing-api";
import type { TestingClearScope } from "../../lib/utils";
import { adminStatusAfterFailure, mergeAdminSessions, type AdminDataStatus } from "./admin-model";

type RoleData =
  | { kind: "operations"; operations: TestingOperationsSnapshot; policies: TestingPolicy[] }
  | { kind: "runs"; runs: TestingRun[] };

export type AdminTestingData = {
  testing: TestingStats | null;
  sessions: TesterSessionSummary[];
  sessionDetails: Record<string, TesterSessionSummary>;
  operations: TestingOperationsSnapshot | null;
  policies: TestingPolicy[];
  runs: TestingRun[];
  nextCursor?: string;
  sessionTotal: number;
  status: AdminDataStatus;
  error: ApiError | null;
  lastSyncedAt: number | null;
  refresh: (replace?: boolean) => Promise<void>;
  loadMore: () => Promise<void>;
  loadSession: (sessionId: string) => Promise<TesterSessionSummary | null>;
  saveNotes: (sessionId: string, notes: string) => Promise<boolean>;
  clearEvidence: (scope: TestingClearScope) => Promise<boolean>;
  createRun: (input: CreateTestingRunInput) => Promise<ApiResult<TestingRun>>;
  updateRun: (runId: string, patch: UpdateTestingRunPatch) => Promise<ApiResult<TestingRun>>;
  createAssignment: (runId: string, requirementId: string, assignee: string) => Promise<ApiResult<TestingRun>>;
  saveReview: (input: Partial<TestingReview> & { sessionId: string }) => Promise<ApiResult<TestingReview>>;
  createPolicy: (input: Partial<TestingPolicy>) => Promise<ApiResult<TestingPolicy>>;
};

async function fetchRoleData(role: AuthUser["role"]): Promise<ApiResult<RoleData>> {
  if (role === "tester") {
    const result = await testingApi.fetchRuns();
    return result.ok ? { ok: true, data: { kind: "runs", runs: result.data } } : result;
  }

  const result = await testingApi.fetchOperations();
  return result.ok
    ? {
        ok: true,
        data: {
          kind: "operations",
          operations: result.data.operations,
          policies: result.data.policies
        }
      }
    : result;
}

function readFailure(...results: ApiResult<unknown>[]): ApiError | null {
  let failure: ApiError | null = null;
  for (const result of results) {
    if (result.ok) continue;
    if (!failure || result.error.kind === "unauthorized") failure = result.error;
  }
  return failure;
}

export function useAdminTestingData({
  user,
  onAuthenticationExpired
}: {
  user: AuthUser;
  onAuthenticationExpired: () => void;
}): AdminTestingData {
  const [testing, setTesting] = useState<TestingStats | null>(null);
  const [sessions, setSessions] = useState<TesterSessionSummary[]>([]);
  const [sessionDetails, setSessionDetails] = useState<Record<string, TesterSessionSummary>>({});
  const [operations, setOperations] = useState<TestingOperationsSnapshot | null>(null);
  const [policies, setPolicies] = useState<TestingPolicy[]>([]);
  const [runs, setRuns] = useState<TestingRun[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [sessionTotal, setSessionTotal] = useState(0);
  const [status, setStatus] = useState<AdminDataStatus>("loading");
  const [error, setError] = useState<ApiError | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);

  const activeRef = useRef(false);
  const scopeRef = useRef(0);
  const scopeSequenceRef = useRef(0);
  const refreshRequestRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const hasLoadedDataRef = useRef(false);
  const sessionsRef = useRef<TesterSessionSummary[]>([]);
  const sessionDetailsRef = useRef<Record<string, TesterSessionSummary>>({});
  const nextCursorRef = useRef<string | undefined>(undefined);
  const authenticationExpiredRef = useRef(onAuthenticationExpired);
  authenticationExpiredRef.current = onAuthenticationExpired;

  const isCurrent = useCallback((scope: number) => activeRef.current && scopeRef.current === scope, []);

  const handleFailure = useCallback(
    (nextError: ApiError, scope: number) => {
      if (!isCurrent(scope)) return;
      setStatus(adminStatusAfterFailure(hasLoadedDataRef.current));
      setError(nextError);
      if (nextError.kind === "unauthorized") authenticationExpiredRef.current();
    },
    [isCurrent]
  );

  const refreshRoleData = useCallback(
    async (scope: number) => {
      if (!isCurrent(scope)) return;
      const result = await fetchRoleData(user.role);
      if (!isCurrent(scope)) return;
      if (!result.ok) {
        handleFailure(result.error, scope);
        return;
      }
      if (result.data.kind === "operations") {
        setOperations(result.data.operations);
        setPolicies(result.data.policies);
      } else {
        setRuns(result.data.runs);
      }
    },
    [handleFailure, isCurrent, user.role]
  );

  const refreshForScope = useCallback(
    async (replace = false, scope: number) => {
      if (!isCurrent(scope)) return;
      const requestId = ++refreshRequestRef.current;
      if (!hasLoadedDataRef.current) setStatus("loading");

      const [summaryResult, sessionsResult, roleResult] = await Promise.all([
        testingApi.fetchSummary(),
        testingApi.fetchSessions({ limit: 100 }),
        fetchRoleData(user.role)
      ]);
      if (!isCurrent(scope) || requestId !== refreshRequestRef.current) return;

      const failure = readFailure(summaryResult, sessionsResult, roleResult);
      if (failure) {
        handleFailure(failure, scope);
        return;
      }
      if (!summaryResult.ok || !sessionsResult.ok || !roleResult.ok) return;

      setTesting(summaryResult.data);
      const preservePagination = !replace && sessionsRef.current.length > sessionsResult.data.items.length;
      const merged = mergeAdminSessions(replace ? [] : sessionsRef.current, sessionsResult.data.items);
      sessionsRef.current = merged;
      setSessions(merged);
      if (!preservePagination) {
        nextCursorRef.current = sessionsResult.data.nextCursor;
        setNextCursor(sessionsResult.data.nextCursor);
      }
      setSessionTotal(sessionsResult.data.total);

      if (replace) {
        sessionDetailsRef.current = {};
        setSessionDetails({});
      }
      if (roleResult.data.kind === "operations") {
        setOperations(roleResult.data.operations);
        setPolicies(roleResult.data.policies);
        setRuns([]);
      } else {
        setRuns(roleResult.data.runs);
        setOperations(null);
        setPolicies([]);
      }

      hasLoadedDataRef.current = true;
      setStatus("ready");
      setError(null);
      setLastSyncedAt(Date.now());
    },
    [handleFailure, isCurrent, user.role]
  );

  const refresh = useCallback(
    async (replace = false) => {
      await refreshForScope(replace, scopeRef.current);
    },
    [refreshForScope]
  );

  const loadMore = useCallback(async () => {
    const scope = scopeRef.current;
    const cursor = nextCursorRef.current;
    if (!isCurrent(scope) || !cursor || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    const result = await testingApi.fetchSessions({ cursor, limit: 100 });
    if (!isCurrent(scope)) return;
    loadingMoreRef.current = false;
    if (!result.ok) {
      handleFailure(result.error, scope);
      return;
    }

    const merged = mergeAdminSessions(sessionsRef.current, result.data.items);
    sessionsRef.current = merged;
    setSessions(merged);
    nextCursorRef.current = result.data.nextCursor;
    setNextCursor(result.data.nextCursor);
    setSessionTotal(result.data.total);
  }, [handleFailure, isCurrent]);

  const loadSession = useCallback(
    async (sessionId: string) => {
      const cached = sessionDetailsRef.current[sessionId];
      if (cached) return cached;
      const scope = scopeRef.current;
      const result = await testingApi.fetchSession(sessionId);
      if (!isCurrent(scope)) return null;
      if (!result.ok) {
        handleFailure(result.error, scope);
        return null;
      }

      const nextDetails = { ...sessionDetailsRef.current, [sessionId]: result.data };
      sessionDetailsRef.current = nextDetails;
      setSessionDetails(nextDetails);
      const merged = mergeAdminSessions(sessionsRef.current, [result.data]);
      sessionsRef.current = merged;
      setSessions(merged);
      return result.data;
    },
    [handleFailure, isCurrent]
  );

  const saveNotes = useCallback(
    async (sessionId: string, notes: string) => {
      const scope = scopeRef.current;
      const result = await testingApi.updateSessionNotes(sessionId, notes);
      if (!isCurrent(scope)) return false;
      if (!result.ok) {
        handleFailure(result.error, scope);
        return false;
      }

      const nextDetails = { ...sessionDetailsRef.current, [sessionId]: result.data };
      sessionDetailsRef.current = nextDetails;
      setSessionDetails(nextDetails);
      const merged = mergeAdminSessions(sessionsRef.current, [result.data]);
      sessionsRef.current = merged;
      setSessions(merged);
      return true;
    },
    [handleFailure, isCurrent]
  );

  const clearEvidence = useCallback(
    async (scopeInput: TestingClearScope) => {
      const scope = scopeRef.current;
      const result = await testingApi.clear(scopeInput);
      if (!isCurrent(scope)) return false;
      if (!result.ok) {
        handleFailure(result.error, scope);
        return false;
      }
      await refreshForScope(true, scope);
      return true;
    },
    [handleFailure, isCurrent, refreshForScope]
  );

  const createRun = useCallback(
    async (input: CreateTestingRunInput) => {
      const scope = scopeRef.current;
      const result = await testingApi.createRun(input);
      if (!result.ok) {
        handleFailure(result.error, scope);
        return result;
      }
      await refreshRoleData(scope);
      return result;
    },
    [handleFailure, refreshRoleData]
  );

  const updateRun = useCallback(
    async (runId: string, patch: UpdateTestingRunPatch) => {
      const scope = scopeRef.current;
      const result = await testingApi.updateRun(runId, patch);
      if (!result.ok) {
        handleFailure(result.error, scope);
        return result;
      }
      await refreshRoleData(scope);
      return result;
    },
    [handleFailure, refreshRoleData]
  );

  const createAssignment = useCallback(
    async (runId: string, requirementId: string, assignee: string) => {
      const scope = scopeRef.current;
      const result = await testingApi.createAssignment(runId, requirementId, assignee);
      if (!result.ok) {
        handleFailure(result.error, scope);
        return result;
      }
      await refreshRoleData(scope);
      return result;
    },
    [handleFailure, refreshRoleData]
  );

  const saveReview = useCallback(
    async (input: Partial<TestingReview> & { sessionId: string }) => {
      const scope = scopeRef.current;
      const result = await testingApi.saveReview(input);
      if (!result.ok) {
        handleFailure(result.error, scope);
        return result;
      }
      await refreshRoleData(scope);
      return result;
    },
    [handleFailure, refreshRoleData]
  );

  const createPolicy = useCallback(
    async (input: Partial<TestingPolicy>) => {
      const scope = scopeRef.current;
      const result = await testingApi.createPolicy(input);
      if (!result.ok) {
        handleFailure(result.error, scope);
        return result;
      }
      await refreshRoleData(scope);
      return result;
    },
    [handleFailure, refreshRoleData]
  );

  useEffect(() => {
    const scope = ++scopeSequenceRef.current;
    scopeRef.current = scope;
    activeRef.current = true;
    refreshRequestRef.current += 1;
    loadingMoreRef.current = false;
    hasLoadedDataRef.current = false;
    sessionsRef.current = [];
    sessionDetailsRef.current = {};
    nextCursorRef.current = undefined;
    setTesting(null);
    setSessions([]);
    setSessionDetails({});
    setOperations(null);
    setPolicies([]);
    setRuns([]);
    setNextCursor(undefined);
    setSessionTotal(0);
    setStatus("loading");
    setError(null);
    setLastSyncedAt(null);

    void refreshForScope(true, scope);
    const timer = window.setInterval(() => void refreshForScope(false, scope), 10_000);
    return () => {
      window.clearInterval(timer);
      if (scopeRef.current === scope) {
        activeRef.current = false;
        loadingMoreRef.current = false;
        refreshRequestRef.current += 1;
      }
    };
  }, [refreshForScope, user.id]);

  return {
    testing,
    sessions,
    sessionDetails,
    operations,
    policies,
    runs,
    nextCursor,
    sessionTotal,
    status,
    error,
    lastSyncedAt,
    refresh,
    loadMore,
    loadSession,
    saveNotes,
    clearEvidence,
    createRun,
    updateRun,
    createAssignment,
    saveReview,
    createPolicy
  };
}
