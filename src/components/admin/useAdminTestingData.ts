import { useCallback, useEffect, useRef, useState } from "react";
import type { TesterSessionSummary, TestingStats } from "../../../shared/agent";
import type {
  TestingOperationsSnapshot,
  TestingPolicy,
  TestingQuality,
  TestingReview,
  TestingReviewStatus,
  TestingRun,
  TestingPlatform,
  TestingValidityStatus
} from "../../../shared/testing";
import type { ApiError, ApiResult } from "../../lib/api-client";
import type { AuthUser } from "../../lib/auth";
import {
  testingApi,
  type CreateTestingRunInput,
  type TestingClearScope,
  type UpdateTestingRunPatch
} from "../../lib/testing-api";
import { adminStatusAfterFailure, mergeAdminSessions, type AdminDataStatus } from "./admin-model";

type RoleData =
  | { kind: "operations"; operations: TestingOperationsSnapshot; policies: TestingPolicy[] }
  | { kind: "runs"; runs: TestingRun[] };

type SyncFailureSource = "full" | "role" | "note";

type ReplacementRefresh = {
  scope: number;
  evidenceGeneration: number;
  promise: Promise<boolean>;
};

type SessionDetailRequest = {
  scope: number;
  evidenceGeneration: number;
  promise: Promise<TesterSessionSummary | null>;
};

type EvidenceSearchStatus = "idle" | "loading" | "ready" | "error";

type EvidenceSearchQuery = {
  search?: string;
  testerId?: string;
  quality?: TestingQuality;
  validity?: TestingValidityStatus;
  build?: string;
  platform?: TestingPlatform;
  reviewStatus?: TestingReviewStatus;
  cursor?: string;
  limit?: number;
};

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
  /** Server-side evidence search across the entire durable corpus, not just the loaded page. */
  searchResults: TesterSessionSummary[];
  searchTotal: number;
  searchCursor?: string;
  searchStatus: EvidenceSearchStatus;
  searchError: ApiError | null;
  searchSessions: (query: EvidenceSearchQuery) => Promise<void>;
  clearSearch: () => void;
  refresh: (replace?: boolean) => Promise<void>;
  loadMore: () => Promise<void>;
  loadSession: (sessionId: string, force?: boolean) => Promise<TesterSessionSummary | null>;
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
  const scopeKey = `${user.id}\u0000${user.role}`;
  const [testing, setTesting] = useState<TestingStats | null>(null);
  const [sessions, setSessions] = useState<TesterSessionSummary[]>([]);
  const [sessionDetails, setSessionDetails] = useState<Record<string, TesterSessionSummary>>({});
  const [operations, setOperations] = useState<TestingOperationsSnapshot | null>(null);
  const [policies, setPolicies] = useState<TestingPolicy[]>([]);
  const [runs, setRuns] = useState<TestingRun[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [sessionTotal, setSessionTotal] = useState(0);
  const [searchResults, setSearchResults] = useState<TesterSessionSummary[]>([]);
  const [searchTotal, setSearchTotal] = useState(0);
  const [searchCursor, setSearchCursor] = useState<string | undefined>();
  const [searchStatus, setSearchStatus] = useState<EvidenceSearchStatus>("idle");
  const [searchError, setSearchError] = useState<ApiError | null>(null);
  const [status, setStatus] = useState<AdminDataStatus>("loading");
  const [error, setError] = useState<ApiError | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);

  const activeRef = useRef(false);
  const scopeRef = useRef(0);
  const scopeSequenceRef = useRef(0);
  const renderedScopeKeyRef = useRef(scopeKey);
  const activeScopeKeyRef = useRef(scopeKey);
  const committedScopeKeyRef = useRef(scopeKey);
  const refreshRequestRef = useRef(0);
  const roleRequestRef = useRef(0);
  const noteRequestRef = useRef(0);
  const noteSessionRequestsRef = useRef(new Map<string, number>());
  const noteFailureRequestRef = useRef(0);
  const evidenceGenerationRef = useRef(0);
  const replacementRequiredRef = useRef<number | null>(null);
  const replacementRefreshRef = useRef<ReplacementRefresh | null>(null);
  const activeRefreshRef = useRef<ReplacementRefresh | null>(null);
  const loadingMoreRef = useRef(false);
  const hasLoadedDataRef = useRef(false);
  const searchSequenceRef = useRef(0);
  const searchResultsRef = useRef<TesterSessionSummary[]>([]);
  const syncFailureSourceRef = useRef<SyncFailureSource | null>(null);
  const expiredScopeRef = useRef<number | null>(null);
  const sessionsRef = useRef<TesterSessionSummary[]>([]);
  const sessionDetailsRef = useRef<Record<string, TesterSessionSummary>>({});
  const completeDetailRevisionRef = useRef(new Map<string, number>());
  const detailRequestsRef = useRef(new Map<string, SessionDetailRequest>());
  const nextCursorRef = useRef<string | undefined>(undefined);
  const authenticationExpiredRef = useRef(onAuthenticationExpired);
  renderedScopeKeyRef.current = scopeKey;
  authenticationExpiredRef.current = onAuthenticationExpired;

  const isCurrent = useCallback(
    (scope: number) =>
      activeRef.current && scopeRef.current === scope && activeScopeKeyRef.current === renderedScopeKeyRef.current,
    []
  );

  const expireAuthentication = useCallback(
    (nextError: ApiError, scope: number) => {
      if (nextError.kind !== "unauthorized" || !isCurrent(scope)) return false;
      if (expiredScopeRef.current !== scope) {
        expiredScopeRef.current = scope;
        authenticationExpiredRef.current();
      }
      return true;
    },
    [isCurrent]
  );

  const setSyncFailure = useCallback(
    (nextError: ApiError, scope: number, source: SyncFailureSource) => {
      if (!isCurrent(scope)) return;
      syncFailureSourceRef.current = source;
      setStatus(adminStatusAfterFailure(hasLoadedDataRef.current));
      setError(nextError);
    },
    [isCurrent]
  );

  const clearRoleSyncFailure = useCallback(
    (scope: number) => {
      if (!isCurrent(scope) || syncFailureSourceRef.current !== "role") return;
      syncFailureSourceRef.current = null;
      setStatus(hasLoadedDataRef.current ? "ready" : "loading");
      setError(null);
    },
    [isCurrent]
  );

  const clearNoteSyncFailure = useCallback(
    (scope: number, requestId: number) => {
      if (
        !isCurrent(scope) ||
        requestId !== noteRequestRef.current ||
        syncFailureSourceRef.current !== "note" ||
        noteFailureRequestRef.current >= requestId
      ) {
        return;
      }
      syncFailureSourceRef.current = null;
      setStatus(hasLoadedDataRef.current ? "ready" : "loading");
      setError(null);
    },
    [isCurrent]
  );

  const writeRoleData = useCallback((data: RoleData) => {
    if (data.kind === "operations") {
      setOperations(data.operations);
      setPolicies(data.policies);
      setRuns([]);
    } else {
      setRuns(data.runs);
      setOperations(null);
      setPolicies([]);
    }
  }, []);

  const refreshRoleData = useCallback(
    async (scope: number) => {
      if (!isCurrent(scope)) return false;
      const requestId = ++roleRequestRef.current;
      const result = await fetchRoleData(user.role);
      if (!isCurrent(scope)) return false;
      const unauthorized = !result.ok && expireAuthentication(result.error, scope);
      if (requestId !== roleRequestRef.current) return false;
      if (!result.ok) {
        setSyncFailure(result.error, scope, "role");
        return false;
      }

      writeRoleData(result.data);
      clearRoleSyncFailure(scope);
      return !unauthorized;
    },
    [clearRoleSyncFailure, expireAuthentication, isCurrent, setSyncFailure, user.role, writeRoleData]
  );

  const executeRefresh = useCallback(
    async (replace: boolean, scope: number, evidenceGeneration: number) => {
      if (!isCurrent(scope) || evidenceGeneration !== evidenceGenerationRef.current) return false;
      const requestId = ++refreshRequestRef.current;
      const roleRequestId = ++roleRequestRef.current;
      const detailsAtStart = sessionDetailsRef.current;
      if (!hasLoadedDataRef.current) setStatus("loading");

      const [summaryResult, sessionsResult, roleResult] = await Promise.all([
        testingApi.fetchSummary(),
        testingApi.fetchSessions({ limit: 100 }),
        fetchRoleData(user.role)
      ]);
      if (!isCurrent(scope)) return false;

      const authenticationFailure = readFailure(summaryResult, sessionsResult, roleResult);
      if (authenticationFailure?.kind === "unauthorized") {
        expireAuthentication(authenticationFailure, scope);
      }

      const refreshIsCurrent =
        requestId === refreshRequestRef.current && evidenceGeneration === evidenceGenerationRef.current;
      if (!refreshIsCurrent) return false;
      const evidenceFailure = readFailure(summaryResult, sessionsResult);
      if (evidenceFailure) {
        setSyncFailure(evidenceFailure, scope, "full");
        return false;
      }
      if (!roleResult.ok) {
        if (roleRequestId === roleRequestRef.current) setSyncFailure(roleResult.error, scope, "full");
        return false;
      }
      if (!summaryResult.ok || !sessionsResult.ok) return false;

      setTesting(summaryResult.data);
      const preservePagination = !replace && sessionsRef.current.length > sessionsResult.data.items.length;
      let refreshedSessions = sessionsResult.data.items;
      if (!replace) {
        const nextDetails = { ...sessionDetailsRef.current };
        refreshedSessions = refreshedSessions.map((summary) => {
          const cached = nextDetails[summary.sessionId];
          if (!cached) return summary;
          // A detail read or note save completed after this poll started.
          // Its newer result must win over the poll's older snapshot.
          if (cached !== detailsAtStart[summary.sessionId]) return cached;
          const updated = { ...cached, ...summary, turns: cached.turns };
          nextDetails[summary.sessionId] = updated;
          return updated;
        });
        sessionDetailsRef.current = nextDetails;
        setSessionDetails(nextDetails);
      }
      const merged = mergeAdminSessions(replace ? [] : sessionsRef.current, refreshedSessions);
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
      const roleWriteIsCurrent = roleRequestId === roleRequestRef.current;
      if (roleWriteIsCurrent) writeRoleData(roleResult.data);

      hasLoadedDataRef.current = true;
      if (replace && replacementRequiredRef.current === evidenceGeneration) {
        replacementRequiredRef.current = null;
      }
      if (roleWriteIsCurrent || syncFailureSourceRef.current !== "role") {
        syncFailureSourceRef.current = null;
        setStatus("ready");
        setError(null);
      }
      setLastSyncedAt(Date.now());
      return true;
    },
    [expireAuthentication, isCurrent, setSyncFailure, user.role, writeRoleData]
  );

  const refreshForScope = useCallback(
    (replace = false, scope: number): Promise<boolean> => {
      if (!isCurrent(scope)) return Promise.resolve(false);
      let evidenceGeneration = evidenceGenerationRef.current;
      if (replace && replacementRequiredRef.current !== evidenceGeneration) {
        evidenceGeneration = ++evidenceGenerationRef.current;
        replacementRequiredRef.current = evidenceGeneration;
        refreshRequestRef.current += 1;
        loadingMoreRef.current = false;
      }
      const replacementRequired = replacementRequiredRef.current === evidenceGeneration;
      const effectiveReplace = replace || replacementRequired;
      const existingReplacement = replacementRefreshRef.current;
      if (
        replacementRequired &&
        existingReplacement?.scope === scope &&
        existingReplacement.evidenceGeneration === evidenceGeneration
      ) {
        return existingReplacement.promise;
      }

      const promise = executeRefresh(effectiveReplace, scope, evidenceGeneration);
      const entry = { scope, evidenceGeneration, promise };
      activeRefreshRef.current = entry;
      if (replacementRequired) replacementRefreshRef.current = entry;
      const releaseRefresh = () => {
        if (activeRefreshRef.current === entry) activeRefreshRef.current = null;
        if (replacementRefreshRef.current === entry) replacementRefreshRef.current = null;
      };
      void promise.then(releaseRefresh, releaseRefresh);
      return promise;
    },
    [executeRefresh, isCurrent]
  );

  const refresh = useCallback(
    async (replace = false) => {
      await refreshForScope(replace, scopeRef.current);
    },
    [refreshForScope]
  );

  const loadMore = useCallback(async () => {
    const scope = scopeRef.current;
    if (!isCurrent(scope)) return;
    const evidenceGeneration = evidenceGenerationRef.current;
    const cursor = nextCursorRef.current;
    if (!cursor || replacementRequiredRef.current === evidenceGeneration || loadingMoreRef.current) {
      return;
    }
    loadingMoreRef.current = true;
    const result = await testingApi.fetchSessions({ cursor, limit: 100 });
    if (!isCurrent(scope)) return;
    if (!result.ok && result.error.kind === "unauthorized") expireAuthentication(result.error, scope);
    if (evidenceGeneration !== evidenceGenerationRef.current) return;
    loadingMoreRef.current = false;
    if (!result.ok) {
      setSyncFailure(result.error, scope, "full");
      return;
    }

    const merged = mergeAdminSessions(sessionsRef.current, result.data.items);
    sessionsRef.current = merged;
    setSessions(merged);
    nextCursorRef.current = result.data.nextCursor;
    setNextCursor(result.data.nextCursor);
    setSessionTotal(result.data.total);
  }, [expireAuthentication, isCurrent, setSyncFailure]);

  /**
   * Server-side evidence search. Runs across the entire durable corpus with the
   * same predicates the sessions page uses, so a transcript match on an
   * unloaded page is still found. Only the newest request may commit, and a
   * commit is void when the evidence generation moved on (clear) or the
   * account/role scope changed mid-flight.
   */
  const searchSessions = useCallback(
    async (query: EvidenceSearchQuery) => {
      const scope = scopeRef.current;
      if (!isCurrent(scope)) return;
      const requestId = ++searchSequenceRef.current;
      const evidenceGeneration = evidenceGenerationRef.current;
      const appending = Boolean(query.cursor);
      if (!appending) {
        searchResultsRef.current = [];
        setSearchResults([]);
        setSearchTotal(0);
        setSearchCursor(undefined);
      }
      setSearchStatus("loading");
      setSearchError(null);
      const result = await testingApi.fetchSessions({ limit: 100, ...query });
      if (!isCurrent(scope)) return;
      if (!result.ok && result.error.kind === "unauthorized") expireAuthentication(result.error, scope);
      if (requestId !== searchSequenceRef.current) return;
      if (evidenceGeneration !== evidenceGenerationRef.current) return;
      if (!result.ok) {
        setSearchStatus("error");
        setSearchError(result.error);
        if (!appending) {
          searchResultsRef.current = [];
          setSearchResults([]);
          setSearchTotal(0);
          setSearchCursor(undefined);
        }
        return;
      }

      const merged = mergeAdminSessions(sessionsRef.current, result.data.items);
      sessionsRef.current = merged;
      setSessions(merged);
      const combined = appending ? mergeAdminSessions(searchResultsRef.current, result.data.items) : result.data.items;
      searchResultsRef.current = combined;
      setSearchResults(combined);
      setSearchTotal(result.data.total);
      setSearchCursor(result.data.nextCursor);
      setSearchStatus("ready");
    },
    [expireAuthentication, isCurrent]
  );

  const clearSearch = useCallback(() => {
    searchSequenceRef.current += 1;
    searchResultsRef.current = [];
    setSearchResults([]);
    setSearchTotal(0);
    setSearchCursor(undefined);
    setSearchStatus("idle");
    setSearchError(null);
  }, []);

  const loadSession = useCallback(
    async (sessionId: string, force = false) => {
      const scope = scopeRef.current;
      if (!isCurrent(scope)) return null;
      const cached = sessionDetailsRef.current[sessionId];
      if (cached && !force) return cached;
      const evidenceGeneration = evidenceGenerationRef.current;
      const pending = detailRequestsRef.current.get(sessionId);
      if (pending?.scope === scope && pending.evidenceGeneration === evidenceGeneration) {
        return pending.promise;
      }
      const completeRevision = completeDetailRevisionRef.current.get(sessionId) ?? 0;
      const promise = (async () => {
        const result = await testingApi.fetchSession(sessionId);
        if (!isCurrent(scope)) return null;
        if (!result.ok && result.error.kind === "unauthorized") expireAuthentication(result.error, scope);
        if (evidenceGeneration !== evidenceGenerationRef.current) return null;
        if (!result.ok) {
          setSyncFailure(result.error, scope, "full");
          return null;
        }

        const newerCached = sessionDetailsRef.current[sessionId];
        // Only a complete detail/note response can supersede this read.
        // Summary polls update metadata but carry no transcript turns.
        if (newerCached && (completeDetailRevisionRef.current.get(sessionId) ?? 0) !== completeRevision) {
          return newerCached;
        }
        const detail =
          newerCached && newerCached !== cached
            ? { ...result.data, ...newerCached, turns: result.data.turns }
            : result.data;
        const nextDetails = { ...sessionDetailsRef.current, [sessionId]: detail };
        completeDetailRevisionRef.current.set(sessionId, completeRevision + 1);
        sessionDetailsRef.current = nextDetails;
        setSessionDetails(nextDetails);
        const merged = mergeAdminSessions(sessionsRef.current, [detail]);
        sessionsRef.current = merged;
        setSessions(merged);
        return detail;
      })();

      const request = { scope, evidenceGeneration, promise };
      detailRequestsRef.current.set(sessionId, request);
      const releaseRequest = () => {
        if (detailRequestsRef.current.get(sessionId) === request) detailRequestsRef.current.delete(sessionId);
      };
      void promise.then(releaseRequest, releaseRequest);
      return promise;
    },
    [expireAuthentication, isCurrent, setSyncFailure]
  );

  const saveNotes = useCallback(
    async (sessionId: string, notes: string) => {
      const scope = scopeRef.current;
      if (!isCurrent(scope)) return false;
      const requestId = ++noteRequestRef.current;
      noteSessionRequestsRef.current.set(sessionId, requestId);
      const evidenceGeneration = evidenceGenerationRef.current;
      const result = await testingApi.updateSessionNotes(sessionId, notes);
      if (!isCurrent(scope)) return false;
      if (!result.ok && expireAuthentication(result.error, scope)) return false;
      if (
        evidenceGeneration !== evidenceGenerationRef.current ||
        requestId !== noteSessionRequestsRef.current.get(sessionId)
      ) {
        return false;
      }
      if (!result.ok) {
        noteFailureRequestRef.current = requestId;
        setSyncFailure(result.error, scope, "note");
        return false;
      }

      const nextDetails = { ...sessionDetailsRef.current, [sessionId]: result.data };
      completeDetailRevisionRef.current.set(sessionId, (completeDetailRevisionRef.current.get(sessionId) ?? 0) + 1);
      sessionDetailsRef.current = nextDetails;
      setSessionDetails(nextDetails);
      const merged = mergeAdminSessions(sessionsRef.current, [result.data]);
      sessionsRef.current = merged;
      setSessions(merged);
      clearNoteSyncFailure(scope, requestId);
      return true;
    },
    [clearNoteSyncFailure, expireAuthentication, isCurrent, setSyncFailure]
  );

  const clearEvidence = useCallback(
    async (scopeInput: TestingClearScope) => {
      const scope = scopeRef.current;
      if (!isCurrent(scope)) return false;
      const result = await testingApi.clear(scopeInput);
      if (!isCurrent(scope)) return false;
      if (!result.ok) {
        if (!expireAuthentication(result.error, scope)) setSyncFailure(result.error, scope, "full");
        return false;
      }

      const evidenceGeneration = ++evidenceGenerationRef.current;
      replacementRequiredRef.current = evidenceGeneration;
      refreshRequestRef.current += 1;
      loadingMoreRef.current = false;
      searchSequenceRef.current += 1;
      searchResultsRef.current = [];
      sessionsRef.current = [];
      sessionDetailsRef.current = {};
      nextCursorRef.current = undefined;
      setSessions([]);
      setSessionDetails({});
      setNextCursor(undefined);
      setSessionTotal(0);
      setSearchResults([]);
      setSearchTotal(0);
      setSearchCursor(undefined);
      setSearchStatus("idle");
      setSearchError(null);
      await refreshForScope(true, scope);
      return true;
    },
    [expireAuthentication, isCurrent, refreshForScope, setSyncFailure]
  );

  const createRun = useCallback(
    async (input: CreateTestingRunInput) => {
      const scope = scopeRef.current;
      const result = await testingApi.createRun(input);
      if (!result.ok) {
        expireAuthentication(result.error, scope);
        return result;
      }
      await refreshRoleData(scope);
      return result;
    },
    [expireAuthentication, refreshRoleData]
  );

  const updateRun = useCallback(
    async (runId: string, patch: UpdateTestingRunPatch) => {
      const scope = scopeRef.current;
      const result = await testingApi.updateRun(runId, patch);
      if (!result.ok) {
        expireAuthentication(result.error, scope);
        return result;
      }
      await refreshRoleData(scope);
      return result;
    },
    [expireAuthentication, refreshRoleData]
  );

  const createAssignment = useCallback(
    async (runId: string, requirementId: string, assignee: string) => {
      const scope = scopeRef.current;
      const result = await testingApi.createAssignment(runId, requirementId, assignee);
      if (!result.ok) {
        expireAuthentication(result.error, scope);
        return result;
      }
      await refreshRoleData(scope);
      return result;
    },
    [expireAuthentication, refreshRoleData]
  );

  const saveReview = useCallback(
    async (input: Partial<TestingReview> & { sessionId: string }) => {
      const scope = scopeRef.current;
      const result = await testingApi.saveReview(input);
      if (!result.ok) {
        expireAuthentication(result.error, scope);
        return result;
      }
      await refreshRoleData(scope);
      return result;
    },
    [expireAuthentication, refreshRoleData]
  );

  const createPolicy = useCallback(
    async (input: Partial<TestingPolicy>) => {
      const scope = scopeRef.current;
      const result = await testingApi.createPolicy(input);
      if (!result.ok) {
        expireAuthentication(result.error, scope);
        return result;
      }
      await refreshRoleData(scope);
      return result;
    },
    [expireAuthentication, refreshRoleData]
  );

  useEffect(() => {
    const scope = ++scopeSequenceRef.current;
    const noteSessionRequests = noteSessionRequestsRef.current;
    const detailRequests = detailRequestsRef.current;
    const completeDetailRevisions = completeDetailRevisionRef.current;
    scopeRef.current = scope;
    activeRef.current = true;
    activeScopeKeyRef.current = scopeKey;
    committedScopeKeyRef.current = scopeKey;
    refreshRequestRef.current += 1;
    roleRequestRef.current += 1;
    noteRequestRef.current += 1;
    noteSessionRequests.clear();
    detailRequests.clear();
    completeDetailRevisions.clear();
    noteFailureRequestRef.current = 0;
    evidenceGenerationRef.current += 1;
    replacementRequiredRef.current = null;
    replacementRefreshRef.current = null;
    activeRefreshRef.current = null;
    loadingMoreRef.current = false;
    hasLoadedDataRef.current = false;
    syncFailureSourceRef.current = null;
    expiredScopeRef.current = null;
    sessionsRef.current = [];
    sessionDetailsRef.current = {};
    nextCursorRef.current = undefined;
    searchSequenceRef.current += 1;
    searchResultsRef.current = [];
    setTesting(null);
    setSessions([]);
    setSessionDetails({});
    setOperations(null);
    setPolicies([]);
    setRuns([]);
    setNextCursor(undefined);
    setSessionTotal(0);
    setSearchResults([]);
    setSearchTotal(0);
    setSearchCursor(undefined);
    setSearchStatus("idle");
    setSearchError(null);
    setStatus("loading");
    setError(null);
    setLastSyncedAt(null);

    void refreshForScope(true, scope);
    const timer = window.setInterval(() => {
      // A slower read must be able to commit before a scheduled poll claims
      // newer ownership. Explicit refreshes can still supersede it.
      if (activeRefreshRef.current?.scope !== scope) void refreshForScope(false, scope);
    }, 10_000);
    return () => {
      window.clearInterval(timer);
      if (scopeRef.current === scope) {
        activeRef.current = false;
        loadingMoreRef.current = false;
        refreshRequestRef.current += 1;
        roleRequestRef.current += 1;
        noteRequestRef.current += 1;
        noteSessionRequests.clear();
        detailRequests.clear();
        completeDetailRevisions.clear();
        noteFailureRequestRef.current = 0;
        evidenceGenerationRef.current += 1;
        replacementRequiredRef.current = null;
        replacementRefreshRef.current = null;
        activeRefreshRef.current = null;
      }
    };
  }, [refreshForScope, scopeKey]);

  const stateMatchesScope =
    committedScopeKeyRef.current === scopeKey && activeScopeKeyRef.current === renderedScopeKeyRef.current;

  return {
    testing: stateMatchesScope ? testing : null,
    sessions: stateMatchesScope ? sessions : [],
    sessionDetails: stateMatchesScope ? sessionDetails : {},
    operations: stateMatchesScope ? operations : null,
    policies: stateMatchesScope ? policies : [],
    runs: stateMatchesScope ? runs : [],
    nextCursor: stateMatchesScope ? nextCursor : undefined,
    sessionTotal: stateMatchesScope ? sessionTotal : 0,
    searchResults: stateMatchesScope ? searchResults : [],
    searchTotal: stateMatchesScope ? searchTotal : 0,
    searchCursor: stateMatchesScope ? searchCursor : undefined,
    searchStatus: stateMatchesScope ? searchStatus : "idle",
    searchError: stateMatchesScope ? searchError : null,
    searchSessions,
    clearSearch,
    status: stateMatchesScope ? status : "loading",
    error: stateMatchesScope ? error : null,
    lastSyncedAt: stateMatchesScope ? lastSyncedAt : null,
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
