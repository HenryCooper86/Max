import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { scenarioLabel } from "../../../shared/ride";
import {
  TESTING_CAMPAIGNS,
  TESTING_TEST_CASES,
  defaultTestCaseForCampaign,
  findTestingCampaign,
  type TestingQuality,
  type TestingReview,
  type TestingReviewSeverity,
  type TestingReviewStatus,
  type TestingTestCase
} from "../../../shared/testing";
import type { HelmetAgent } from "../../hooks/useHelmetAgent";
import { useLanguage } from "../LanguageToggle";
import { localized, type Language } from "../../lib/i18n";
import type { AuthUser } from "../../lib/auth";
import type { TestingClearScope } from "../../lib/testing-api";
import {
  exportTestingReport,
  exportTestingSession,
  formatBytes,
  formatClockTime,
  formatDuration
} from "../../lib/utils";
import {
  confirmationCopy,
  corpusIssueCount,
  formatAdminRelativeTime,
  testingReviewSeverityLabel,
  testingReviewStatusLabel
} from "./admin-model";
import { readAdminLocation, setAdminLocation, useAdminLocation } from "./admin-location";
import type { AdminTestingData } from "./useAdminTestingData";
import type { TesterSessionSummary } from "../../../shared/agent";

const TEST_QUALITY_FILTERS = ["all", "pass", "watch", "fail"] as const;
type TestQualityFilter = (typeof TEST_QUALITY_FILTERS)[number];
type QualityCounts = Record<TestingQuality, number>;
type PendingNoteSave = {
  requestId: number;
  sessionId: string;
  notes: string;
};
type Notice = { tone: "success" | "error"; message: string };
type ReviewBusyTarget = { kind: "composer"; sessionId: string } | { kind: "status"; reviewId: string } | null;
type ReviewDraftFields = {
  title: string;
  comment: string;
  severity: TestingReviewSeverity;
  owner: string;
};
type ReviewDraftBinding = {
  generation: number;
  sessionId: string;
  reviewId?: string;
  serverRevision: number;
};
type ReviewMutationRequest = {
  key: string;
  requestId: number;
  noticeRequestId: number;
};
type StashedReviewDraft = {
  fields: ReviewDraftFields;
  reviewId?: string;
  serverRevision: number;
};
type EvidenceDraftStore = {
  notes: Record<string, string>;
  reviews: Record<string, StashedReviewDraft>;
};
type DetailTab = "conversation" | "diagnostics" | "review";
type PlatformFilter = "" | "web" | "ios" | "android" | "embedded" | "unknown";
type ReviewStatusFilter = "all" | TestingReviewStatus;

const QUALITY_PRIORITY: Record<TestingQuality, number> = { fail: 3, watch: 2, pass: 1 };
const REVIEW_STATUSES: TestingReviewStatus[] = ["open", "triaged", "resolved", "waived"];
const REVIEW_SEVERITIES: TestingReviewSeverity[] = ["low", "medium", "high", "critical"];
const REVIEW_STATUS_FILTERS: ReviewStatusFilter[] = ["all", ...REVIEW_STATUSES];
const PLATFORM_FILTERS: PlatformFilter[] = ["", "web", "ios", "android", "embedded", "unknown"];
const DETAIL_TABS: DetailTab[] = ["conversation", "diagnostics", "review"];
const DRAFT_STORE_PREFIX = "max-admin-evidence-drafts:";

function reviewBusyTargetKey(target: Exclude<ReviewBusyTarget, null>) {
  return target.kind === "composer" ? `review-composer:${target.sessionId}` : `review-status:${target.reviewId}`;
}

function editableReview(review: TestingReview | undefined) {
  return review && (review.status === "open" || review.status === "triaged") ? review : undefined;
}

function findEditableReview(reviews: TestingReview[], sessionId: string) {
  return reviews.find(
    (review) => review.sessionId === sessionId && (review.status === "open" || review.status === "triaged")
  );
}

function sameReviewDraft(left: ReviewDraftFields, right: ReviewDraftFields) {
  return (
    left.title === right.title &&
    left.comment === right.comment &&
    left.severity === right.severity &&
    left.owner === right.owner
  );
}

function testQualityLabel(quality: TestQualityFilter, language: Language) {
  if (quality === "all") return localized(language, "全部", "All");
  if (quality === "pass") return "PASS";
  if (quality === "watch") return "WATCH";
  return "FAIL";
}

function parseQualityFilter(value: string | null): TestQualityFilter {
  return value === "pass" || value === "watch" || value === "fail" ? value : "all";
}

function parseReviewStatusFilter(value: string | null): ReviewStatusFilter {
  return REVIEW_STATUS_FILTERS.includes(value as ReviewStatusFilter) ? (value as ReviewStatusFilter) : "all";
}

function parsePlatformFilter(value: string | null): PlatformFilter {
  return PLATFORM_FILTERS.includes(value as PlatformFilter) ? (value as PlatformFilter) : "";
}

function parseDetailTab(value: string | null, canReview: boolean): DetailTab {
  const tab = DETAIL_TABS.includes(value as DetailTab) ? (value as DetailTab) : "conversation";
  return tab === "review" && !canReview ? "conversation" : tab;
}

function testQualityClass(quality: TestingQuality) {
  return quality === "pass" ? "good" : quality === "watch" ? "warn" : "alert";
}

function emptyQualityCounts(): QualityCounts {
  return { pass: 0, watch: 0, fail: 0 };
}

function qualityBreakdownLabel(counts: QualityCounts) {
  return `${counts.fail} FAIL · ${counts.watch} WATCH · ${counts.pass} PASS`;
}

function flaggedTurns(session: { turns: { feedback?: string }[] }) {
  return session.turns.filter((turn) => Boolean(turn.feedback)).length;
}

function sessionIssueCount(session: {
  validity?: { status: string; reasons: string[] };
  turns: { feedback?: string }[];
  evaluation: { checks: { status: string }[] };
}) {
  const issues = new Set(
    session.evaluation.checks
      .filter((check) => check.status === "fail" || check.status === "warn")
      .map((_check, index) => `check:${index}`)
  );
  for (let index = 0; index < flaggedTurns(session); index += 1) issues.add(`feedback:${index}`);
  for (const reason of session.validity?.status === "invalid" ? session.validity.reasons : []) {
    issues.add(`validity:${reason}`);
  }
  return issues.size;
}

function testRequirementLabels(testCase: TestingTestCase, language: Language) {
  return [
    testCase.requireWakeWord ? localized(language, "唤醒词", "Wake word") : null,
    testCase.requireMicAudio ? localized(language, "麦克风音频", "Mic audio") : null,
    testCase.requireTranscript ? localized(language, "转写", "Transcript") : null,
    testCase.requireEmergencyResponse ? localized(language, "紧急响应", "Emergency response") : null,
    testCase.requireAdasAlert ? localized(language, "ADAS 警报", "ADAS alert") : null,
    testCase.forbidUnsafeAdvice ? localized(language, "禁止不安全建议", "No unsafe advice") : null
  ].filter((requirement): requirement is string => Boolean(requirement));
}

function formatSessionDate(timestamp: number, language: Language) {
  return new Intl.DateTimeFormat(language === "en-US" ? "en-US" : "zh-CN", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(timestamp);
}

function barHeight(value: number, max: number) {
  if (!Number.isFinite(value) || value <= 0 || max <= 0) return "3%";
  return `${Math.max(6, Math.round((value / max) * 100))}%`;
}

/** Missing latency is unknown, not a 0ms success. */
function latencyLabel(samples: number, milliseconds: number) {
  return samples > 0 && Number.isFinite(milliseconds) && milliseconds >= 0 ? `${milliseconds}ms` : "—";
}

/**
 * Client-side mirror of the server's EXACT evidence predicates (tester,
 * quality, platform, build, review status). Free-text search is deliberately
 * NOT mirrored: the server matches the entire payload, so a client-side
 * approximation could only produce false deselects. Used only to decide
 * whether the current selection survives a filter change; the server query
 * stays authoritative for what the list shows.
 */
function sessionMatchesFilters(
  session: TesterSessionSummary,
  filters: {
    testerId: string;
    quality: TestQualityFilter;
    build: string;
    platform: PlatformFilter;
    reviewStatus: ReviewStatusFilter;
    reviewStatusesOfSession?: ReadonlySet<TestingReviewStatus>;
  }
) {
  if (filters.testerId && session.testerId !== filters.testerId) return false;
  if (filters.quality !== "all" && session.quality !== filters.quality) return false;
  if (filters.platform && session.platform !== filters.platform) return false;
  const build = filters.build.trim().toLowerCase();
  if (build && !`${session.appVersion} ${session.gitCommit}`.toLowerCase().includes(build)) return false;
  // A status filter matches any independent review currently attached to the
  // session, not only its most recently updated review.
  if (filters.reviewStatus !== "all" && !filters.reviewStatusesOfSession?.has(filters.reviewStatus)) return false;
  return true;
}

function draftStoreKey(user: AuthUser) {
  return `${DRAFT_STORE_PREFIX}${user.id}:${user.role}`;
}

function readDraftStore(key: string): EvidenceDraftStore | null {
  try {
    const storage = typeof window === "undefined" ? undefined : window.sessionStorage;
    const raw = storage?.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<EvidenceDraftStore>;
    const notes: Record<string, string> = {};
    const reviews: Record<string, StashedReviewDraft> = {};
    for (const [sessionId, value] of Object.entries(parsed.notes ?? {})) {
      if (typeof value === "string") notes[sessionId] = value;
    }
    for (const [sessionId, value] of Object.entries(parsed.reviews ?? {})) {
      if (value && typeof value === "object" && value.fields) reviews[sessionId] = value;
    }
    return { notes, reviews };
  } catch {
    return null;
  }
}

function removeDraftStore(key: string) {
  try {
    if (typeof window !== "undefined" && window.sessionStorage) window.sessionStorage.removeItem(key);
  } catch {
    // Storage unavailable (private mode, non-DOM tests): drafts stay in memory.
  }
}

type Props = {
  active: boolean;
  focusRequestKey?: number;
  requestedSessionId: string | null;
  onRequestedSessionHandled: (sessionId: string) => void;
  agent: HelmetAgent;
  user: AuthUser;
  data: AdminTestingData;
};

export function EvidenceWorkspace({
  active,
  focusRequestKey = 0,
  requestedSessionId,
  onRequestedSessionHandled,
  agent,
  user,
  data
}: Props) {
  const { language } = useLanguage();
  const location = useAdminLocation();
  const [query, setQuery] = useState("");
  const [testerIdFilter, setTesterIdFilter] = useState("");
  const [qualityFilter, setQualityFilter] = useState<TestQualityFilter>("all");
  const [buildFilter, setBuildFilter] = useState("");
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>("");
  const [reviewFilter, setReviewFilter] = useState<ReviewStatusFilter>("all");
  const [detailTab, setDetailTab] = useState<DetailTab>("conversation");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectionLoad, setSelectionLoad] = useState<{ id: string; status: "loading" | "unavailable" } | null>(null);
  const [focusedReviewId, setFocusedReviewId] = useState<string | null>(null);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [testerFilter, setTesterFilter] = useState("");
  const [armedAction, setArmedAction] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pendingNoteSave, setPendingNoteSave] = useState<PendingNoteSave | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [reviewBusyTargets, setReviewBusyTargets] = useState<ReadonlySet<string>>(() => new Set());
  const [reviewTitle, setReviewTitle] = useState(localized(language, "会话需要复核", "Session needs review"));
  const [reviewComment, setReviewComment] = useState("");
  const [reviewSeverity, setReviewSeverity] = useState<TestingReviewSeverity>("medium");
  const [reviewOwner, setReviewOwner] = useState(user.username);
  const [sessionNotes, setSessionNotes] = useState("");
  const [notesDirty, setNotesDirty] = useState(false);
  const [draftStoreVersion, setDraftStoreVersion] = useState(0);
  const notesDirtyRef = useRef(false);
  const noteSessionIdRef = useRef<string | null>(null);
  const sessionNotesRef = useRef("");
  const noteSaveRequestRef = useRef(0);
  const workspaceRef = useRef<HTMLElement>(null);
  const handledFocusRequestRef = useRef(0);
  const noticeRequestRef = useRef(0);
  const reviewMutationSequenceRef = useRef(0);
  const reviewTargetRequestRef = useRef(new Map<string, number>());
  const evidenceNavigationRequestRef = useRef(0);
  const reviewDraftGenerationRef = useRef(0);
  const reviewDraftBindingRef = useRef<ReviewDraftBinding | null>(null);
  const reviewDraftDirtyRef = useRef(false);
  const reviewDraftRef = useRef<ReviewDraftFields>({
    title: localized(language, "会话需要复核", "Session needs review"),
    comment: "",
    severity: "medium",
    owner: user.username
  });
  const notesStashRef = useRef<Record<string, string>>({});
  const reviewStashRef = useRef<Record<string, StashedReviewDraft>>({});
  const draftScopeRef = useRef<string | null>(null);
  const draftStorageKeyRef = useRef<string | null>(null);
  const scopeResetKeyRef = useRef<string | null>(null);
  const languageRef = useRef(language);
  const lastEvidenceUrlRef = useRef<string | null>(null);
  const sawOtherSectionRef = useRef(false);
  // Filters are read inside URL/handoff handlers that must see the newest
  // values without re-subscribing; mirror them in refs each render.
  const queryRef = useRef(query);
  const testerIdFilterRef = useRef(testerIdFilter);
  const qualityFilterRef = useRef(qualityFilter);
  const buildFilterRef = useRef(buildFilter);
  const platformFilterRef = useRef(platformFilter);
  const reviewFilterRef = useRef(reviewFilter);
  const detailTabRef = useRef(detailTab);
  const selectedSessionIdRef = useRef(selectedSessionId);
  const focusedReviewIdRef = useRef(focusedReviewId);
  queryRef.current = query;
  testerIdFilterRef.current = testerIdFilter;
  qualityFilterRef.current = qualityFilter;
  buildFilterRef.current = buildFilter;
  platformFilterRef.current = platformFilter;
  reviewFilterRef.current = reviewFilter;
  detailTabRef.current = detailTab;
  selectedSessionIdRef.current = selectedSessionId;
  focusedReviewIdRef.current = focusedReviewId;

  const writeSessionNotes = useCallback((notes: string) => {
    sessionNotesRef.current = notes;
    setSessionNotes(notes);
  }, []);
  const claimNoticeRequest = useCallback(() => {
    const requestId = ++noticeRequestRef.current;
    setNotice(null);
    return requestId;
  }, []);
  const setOwnedNotice = useCallback((requestId: number, nextNotice: Notice | null) => {
    if (noticeRequestRef.current === requestId) setNotice(nextNotice);
  }, []);
  languageRef.current = language;
  const persistDrafts = useCallback(() => {
    try {
      const storage = typeof window === "undefined" ? undefined : window.sessionStorage;
      if (!storage) return;
      const key = draftStoreKey(user);
      const hasNotes = Object.keys(notesStashRef.current).length > 0;
      const hasReviews = Object.keys(reviewStashRef.current).length > 0;
      if (!hasNotes && !hasReviews) storage.removeItem(key);
      else storage.setItem(key, JSON.stringify({ notes: notesStashRef.current, reviews: reviewStashRef.current }));
    } catch {
      // Storage unavailable: drafts stay in memory for this mounted session.
    }
    setDraftStoreVersion((version) => version + 1);
  }, [user]);

  const resetReviewDraft = useCallback(
    (sessionId: string, review?: TestingReview) => {
      const stashed = reviewStashRef.current[sessionId];
      // An unsaved draft for this session wins over whatever the server now
      // says; the conflict banner handles a changed underlying review.
      const nextDraft: ReviewDraftFields = stashed
        ? stashed.fields
        : {
            title: review?.title ?? localized(language, "会话需要复核", "Session needs review"),
            comment: review?.comment ?? "",
            severity: review?.severity ?? "medium",
            owner: review?.owner ?? user.username
          };
      reviewDraftBindingRef.current = {
        generation: ++reviewDraftGenerationRef.current,
        sessionId,
        reviewId: stashed ? stashed.reviewId : review?.id,
        serverRevision: stashed ? stashed.serverRevision : (review?.updatedAt ?? 0)
      };
      reviewDraftDirtyRef.current = Boolean(stashed);
      reviewDraftRef.current = nextDraft;
      setReviewTitle(nextDraft.title);
      setReviewComment(nextDraft.comment);
      setReviewSeverity(nextDraft.severity);
      setReviewOwner(nextDraft.owner);
    },
    [language, user.username]
  );
  const clearReviewDraftBinding = useCallback(() => {
    reviewDraftBindingRef.current = null;
    reviewDraftDirtyRef.current = false;
  }, []);
  const applySessionNotes = useCallback(
    (sessionId: string | null, serverNotes: string) => {
      noteSessionIdRef.current = sessionId;
      const stashed = sessionId !== null ? notesStashRef.current[sessionId] : undefined;
      if (stashed !== undefined) {
        notesDirtyRef.current = true;
        setNotesDirty(true);
        writeSessionNotes(stashed);
        return;
      }
      notesDirtyRef.current = false;
      setNotesDirty(false);
      writeSessionNotes(serverNotes);
    },
    [writeSessionNotes]
  );
  const claimEvidenceNavigationIntent = useCallback(
    ({ retainRequestedSession = false }: { retainRequestedSession?: boolean } = {}) => {
      const requestId = ++evidenceNavigationRequestRef.current;
      if (!retainRequestedSession && requestedSessionId) {
        onRequestedSessionHandled(requestedSessionId);
      }
      return requestId;
    },
    [onRequestedSessionHandled, requestedSessionId]
  );
  const ownsEvidenceNavigationIntent = useCallback(
    (requestId: number) => evidenceNavigationRequestRef.current === requestId,
    []
  );

  const { loadSession, searchSessions, clearSearch } = data;
  const testing = data.testing;
  const testingSessions = data.sessions;
  const sessionDetails = data.sessionDetails;
  const testingTotals = testing?.totals;
  const testingTimeline = testing?.timeline ?? [];
  const testingCampaigns = testing?.catalog?.campaigns?.length ? testing.catalog.campaigns : TESTING_CAMPAIGNS;
  const testingTestCases = testing?.catalog?.testCases?.length ? testing.catalog.testCases : TESTING_TEST_CASES;
  const selectedCampaign =
    testingCampaigns.find((campaign) => campaign.id === agent.testingCampaignId) ??
    testingCampaigns.at(0) ??
    findTestingCampaign(undefined);
  const selectedTestCase =
    testingTestCases.find((testCase) => testCase.id === agent.testingTestCaseId) ??
    defaultTestCaseForCampaign(selectedCampaign.id);
  const testCasesForCampaign = testingTestCases.filter((testCase) => testCase.campaignId === selectedCampaign.id);
  const testerUsers = testing?.users ?? [];
  const currentTester = testerUsers.find((tester) => tester.testerId === agent.testerId);
  const selectedTester = testerIdFilter ? testerUsers.find((tester) => tester.testerId === testerIdFilter) : undefined;
  const selectedTesterTurns = selectedTester?.recentTurns ?? [];
  const canClear = user.role === "admin";
  const canReview = user.role === "admin" || user.role === "reviewer";

  const serverQuery = useMemo(
    () => ({
      search: query.trim() || undefined,
      testerId: testerIdFilter || undefined,
      quality: qualityFilter === "all" ? undefined : qualityFilter,
      build: buildFilter.trim() || undefined,
      platform: platformFilter || undefined,
      reviewStatus: canReview && reviewFilter !== "all" ? reviewFilter : undefined
    }),
    [buildFilter, canReview, platformFilter, qualityFilter, query, reviewFilter, testerIdFilter]
  );
  const searchActive = Boolean(
    serverQuery.search ||
    serverQuery.testerId ||
    serverQuery.quality ||
    serverQuery.build ||
    serverQuery.platform ||
    serverQuery.reviewStatus
  );

  const normalizedTesterFilter = testerFilter.trim().toLowerCase();
  const filteredTesterUsers = testerUsers
    .filter((tester) => {
      if (!normalizedTesterFilter) return true;
      return `${tester.testerId} ${tester.ipAddress} ${tester.region}`.toLowerCase().includes(normalizedTesterFilter);
    })
    .sort(
      (a, b) =>
        b.activeSessions - a.activeSessions ||
        b.qualityCounts.fail - a.qualityCounts.fail ||
        b.qualityCounts.watch - a.qualityCounts.watch ||
        b.errorEvents - a.errorEvents ||
        b.p95LatencyMs - a.p95LatencyMs ||
        b.lastSeenAt - a.lastSeenAt
    );

  const localTestingSessions = useMemo(
    () =>
      [...testingSessions].sort(
        (a, b) =>
          QUALITY_PRIORITY[b.quality] - QUALITY_PRIORITY[a.quality] ||
          sessionIssueCount(b) - sessionIssueCount(a) ||
          b.endedAt - a.endedAt
      ),
    [testingSessions]
  );
  const visibleSessions = searchActive ? data.searchResults : localTestingSessions;

  const operationReviews = useMemo(() => data.operations?.reviews ?? [], [data.operations?.reviews]);
  const reviewStatusesBySession = useMemo(() => {
    const statuses = new Map<string, Set<TestingReviewStatus>>();
    for (const review of operationReviews) {
      let sessionStatuses = statuses.get(review.sessionId);
      if (!sessionStatuses) {
        sessionStatuses = new Set<TestingReviewStatus>();
        statuses.set(review.sessionId, sessionStatuses);
      }
      sessionStatuses.add(review.status);
    }
    return statuses;
  }, [operationReviews]);
  const reviewFilterRevision = useMemo(
    () =>
      canReview && reviewFilter !== "all"
        ? operationReviews.map((review) => `${review.id}:${review.status}:${review.updatedAt}`).join("|")
        : "",
    [canReview, operationReviews, reviewFilter]
  );

  const selectedSessionSummary = selectedSessionId
    ? testingSessions.find((session) => session.sessionId === selectedSessionId)
    : undefined;
  const selectedSession = selectedSessionId ? (sessionDetails[selectedSessionId] ?? selectedSessionSummary) : undefined;
  const focusedReview = focusedReviewId ? operationReviews.find((review) => review.id === focusedReviewId) : undefined;
  const selectedReview = selectedSession
    ? (editableReview(focusedReview) ?? findEditableReview(operationReviews, selectedSession.sessionId))
    : undefined;
  const requestedSessionSummary = requestedSessionId
    ? testingSessions.find((session) => session.sessionId === requestedSessionId)
    : undefined;
  const requestedReview = requestedSessionId ? findEditableReview(operationReviews, requestedSessionId) : undefined;
  const selectedSessionTurns = selectedSession?.turns ?? [];
  const selectedTesterCounts = selectedTester?.qualityCounts ?? emptyQualityCounts();
  const selectedSessionIssues = selectedSession ? sessionIssueCount(selectedSession) : 0;
  const selectedTestRequirements = testRequirementLabels(selectedTestCase, language);
  const totalDownBytes = (testingTotals?.audioDownBytes ?? 0) + (testingTotals?.controlDownBytes ?? 0);
  const totalBandwidthBytes = (testingTotals?.audioUpBytes ?? 0) + totalDownBytes;
  const timelineLatencySamples = testingTimeline.reduce((sum, bucket) => sum + bucket.latencySamples, 0);
  const hasDecisionGradeEvidence = (testingTotals?.validTestSessions ?? 0) > 0;
  const maxBandwidthBucket = Math.max(
    1,
    ...testingTimeline.map((bucket) => bucket.audioUpBytes + bucket.audioDownBytes + bucket.controlDownBytes)
  );
  const maxLatencyBucket = Math.max(1, ...testingTimeline.map((bucket) => bucket.avgLatencyMs));
  const qualityTone = !hasDecisionGradeEvidence
    ? (testingTotals?.activeTestSessions ?? 0) > 0
      ? "collecting"
      : (testingTotals?.invalidTestSessions ?? 0) > 0
        ? "invalid"
        : "none"
    : testerUsers.some((tester) => tester.qualityCounts.fail > 0) ||
        (testingTotals?.errorEvents ?? 0) > 0 ||
        (testingTotals?.p95LatencyMs ?? 0) > 800
      ? "alert"
      : testerUsers.some((tester) => tester.qualityCounts.watch > 0) ||
          (testingTotals?.invalidTestSessions ?? 0) > 0 ||
          (testingTotals?.p95LatencyMs ?? 0) > 320 ||
          (testingTotals?.ttsFallbacks ?? 0) > 0
        ? "warn"
        : "good";
  const currentDraftIsSaving =
    pendingNoteSave !== null &&
    pendingNoteSave.sessionId === selectedSession?.sessionId &&
    pendingNoteSave.notes === sessionNotes;
  const renderedReviewBinding = reviewDraftBindingRef.current;
  const reviewBindingConflict =
    Boolean(selectedSession) &&
    reviewDraftDirtyRef.current &&
    renderedReviewBinding !== null &&
    renderedReviewBinding?.sessionId === selectedSession?.sessionId &&
    renderedReviewBinding.reviewId !== selectedReview?.id;
  const hasDirtyDrafts =
    Object.keys(notesStashRef.current).length > 0 || Object.keys(reviewStashRef.current).length > 0;

  useEffect(() => {
    if (!armedAction) return;
    const timer = window.setTimeout(() => setArmedAction(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [armedAction]);

  useEffect(() => {
    setArmedAction(null);
  }, [selectedSession?.sessionId, selectedTester?.testerKey]);

  const writeEvidenceUrl = useCallback((updates: Record<string, string | null>) => {
    // A hidden evidence panel must never rewrite the route of the section the
    // operator is actually looking at.
    const current = readAdminLocation();
    if (!current.isAdmin || current.section !== "evidence") return;
    const params = new URLSearchParams(current.params);
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === "") params.delete(key);
      else params.set(key, value);
    }
    lastEvidenceUrlRef.current = params.toString();
    sawOtherSectionRef.current = false;
    setAdminLocation("evidence", updates, true);
  }, []);

  const currentEvidenceUpdates = useCallback((): Record<string, string | null> => {
    const tab = detailTabRef.current;
    return {
      session: selectedSessionIdRef.current,
      q: queryRef.current || null,
      tester: testerIdFilterRef.current || null,
      quality: qualityFilterRef.current === "all" ? null : qualityFilterRef.current,
      build: buildFilterRef.current || null,
      platform: platformFilterRef.current || null,
      review: canReview && reviewFilterRef.current !== "all" ? reviewFilterRef.current : null,
      tab: tab === "conversation" ? null : tab,
      reviewId: focusedReviewIdRef.current
    };
  }, [canReview]);

  const selectSession = useCallback(
    (
      sessionId: string,
      options: { claimIntent?: boolean; review?: TestingReview; writeUrl?: boolean; openMobileDetail?: boolean } = {}
    ) => {
      const { claimIntent = true, writeUrl = true, openMobileDetail = true } = options;
      if (claimIntent) {
        claimEvidenceNavigationIntent();
        claimNoticeRequest();
      }
      const session = sessionDetails[sessionId] ?? testingSessions.find((item) => item.sessionId === sessionId);
      setArmedAction(null);
      const boundReview = options.review ?? findEditableReview(operationReviews, sessionId);
      resetReviewDraft(sessionId, boundReview);
      applySessionNotes(sessionId, session?.notes ?? "");
      setSelectedSessionId(sessionId);
      setFocusedReviewId(options.review?.id ?? null);
      setMobileDetailOpen(openMobileDetail);
      if (openMobileDetail && window.matchMedia?.("(max-width: 900px)").matches) {
        window.requestAnimationFrame(() => {
          const detail = workspaceRef.current?.querySelector<HTMLElement>(".sessionDetail");
          detail?.scrollIntoView({ block: "start" });
          detail?.querySelector<HTMLElement>(".evidenceBackToResults")?.focus({ preventScroll: true });
        });
      }
      if (writeUrl) writeEvidenceUrl({ session: sessionId, reviewId: options.review?.id ?? null });
    },
    [
      applySessionNotes,
      claimEvidenceNavigationIntent,
      claimNoticeRequest,
      operationReviews,
      resetReviewDraft,
      sessionDetails,
      testingSessions,
      writeEvidenceUrl
    ]
  );

  const clearSelectedSession = useCallback(
    (options: { writeUrl?: boolean } = {}) => {
      setSelectedSessionId(null);
      setFocusedReviewId(null);
      setMobileDetailOpen(false);
      noteSessionIdRef.current = null;
      notesDirtyRef.current = false;
      setNotesDirty(false);
      writeSessionNotes("");
      clearReviewDraftBinding();
      if (options.writeUrl !== false) writeEvidenceUrl({ session: null, reviewId: null });
    },
    [clearReviewDraftBinding, writeEvidenceUrl, writeSessionNotes]
  );

  const applyEvidenceParams = useCallback(
    (params: URLSearchParams) => {
      setQuery(params.get("q") ?? "");
      setTesterIdFilter(params.get("tester") ?? "");
      setQualityFilter(parseQualityFilter(params.get("quality")));
      setBuildFilter(params.get("build") ?? "");
      setPlatformFilter(parsePlatformFilter(params.get("platform")));
      setReviewFilter(parseReviewStatusFilter(params.get("review")));
      setDetailTab(parseDetailTab(params.get("tab"), canReview));
      const reviewIdParam = canReview ? params.get("reviewId") : null;
      const focused = reviewIdParam ? operationReviews.find((review) => review.id === reviewIdParam) : undefined;
      setFocusedReviewId(focused ? reviewIdParam : null);
      const sessionParam = params.get("session");
      if (sessionParam) {
        if (sessionParam !== selectedSessionIdRef.current) {
          selectSession(sessionParam, { claimIntent: true, review: editableReview(focused), writeUrl: false });
        } else if (focused && focused.id !== focusedReviewIdRef.current) {
          setFocusedReviewId(focused.id);
        }
      } else if (selectedSessionIdRef.current !== null) {
        clearSelectedSession({ writeUrl: false });
      }
    },
    [canReview, clearSelectedSession, operationReviews, selectSession]
  );

  // Draft store scope: rehydrate the account's stashed drafts once on mount;
  // a live account or role change must never carry drafts across scopes.
  useEffect(() => {
    const scopeKey = `${user.id}:${user.role}:${user.username}`;
    if (draftScopeRef.current === null) {
      draftScopeRef.current = scopeKey;
      draftStorageKeyRef.current = draftStoreKey(user);
      const stored = readDraftStore(draftStoreKey(user));
      if (stored && (Object.keys(stored.notes).length > 0 || Object.keys(stored.reviews).length > 0)) {
        notesStashRef.current = stored.notes;
        reviewStashRef.current = stored.reviews;
        setDraftStoreVersion((version) => version + 1);
      }
      return;
    }
    if (draftScopeRef.current === scopeKey) return;
    const previousKey = draftStorageKeyRef.current;
    draftScopeRef.current = scopeKey;
    draftStorageKeyRef.current = draftStoreKey(user);
    notesStashRef.current = {};
    reviewStashRef.current = {};
    if (previousKey) removeDraftStore(previousKey);
    removeDraftStore(draftStoreKey(user));
    setDraftStoreVersion((version) => version + 1);
  }, [user]);

  // URL → state hydration. Shares the shell's hash URL so a session, filters
  // and tab survive reload and Back/Forward. Round-trips through another admin
  // section keep the mounted state (and its unsaved drafts) untouched.
  useEffect(() => {
    if (!location.isAdmin || location.section !== "evidence") {
      sawOtherSectionRef.current = true;
      return;
    }
    const url = location.params.toString();
    const current = readAdminLocation();
    if (!current.isAdmin || current.section !== "evidence" || current.params.toString() !== url) return;
    if (lastEvidenceUrlRef.current === null) {
      lastEvidenceUrlRef.current = url;
      if (location.params.size > 0 && !requestedSessionId) applyEvidenceParams(location.params);
      return;
    }
    if (url === lastEvidenceUrlRef.current && !sawOtherSectionRef.current) return;
    if (requestedSessionId) {
      lastEvidenceUrlRef.current = url;
      return;
    }
    if (sawOtherSectionRef.current && location.params.size === 0) {
      // Returning from another section with a bare evidence URL: preserve the
      // working state, then make the URL describe it again.
      sawOtherSectionRef.current = false;
      writeEvidenceUrl(currentEvidenceUpdates());
      return;
    }
    sawOtherSectionRef.current = false;
    lastEvidenceUrlRef.current = url;
    applyEvidenceParams(location.params);
  }, [applyEvidenceParams, currentEvidenceUpdates, location, requestedSessionId, writeEvidenceUrl]);

  useEffect(() => {
    // Evidence, notes, and review drafts are scoped to the authenticated identity
    // and authority. Never carry them across a live account or role refresh.
    const scopeKey = `${user.id}:${user.role}:${user.username}`;
    if (scopeResetKeyRef.current === scopeKey) return;
    const isFirstRun = scopeResetKeyRef.current === null;
    scopeResetKeyRef.current = scopeKey;
    // The initial render already carries the default scope state.
    if (isFirstRun) return;
    reviewMutationSequenceRef.current += 1;
    reviewTargetRequestRef.current.clear();
    setReviewBusyTargets(new Set());
    claimNoticeRequest();
    clearReviewDraftBinding();
    const freshDraft: ReviewDraftFields = {
      title: localized(languageRef.current, "会话需要复核", "Session needs review"),
      comment: "",
      severity: "medium",
      owner: user.username
    };
    reviewDraftRef.current = freshDraft;
    setReviewTitle(freshDraft.title);
    setReviewComment("");
    setReviewSeverity("medium");
    setReviewOwner(user.username);
    noteSaveRequestRef.current += 1;
    setPendingNoteSave(null);
    applySessionNotes(null, "");
    setSelectedSessionId(null);
    setFocusedReviewId(null);
    setQuery("");
    setTesterIdFilter("");
    setQualityFilter("all");
    setBuildFilter("");
    setPlatformFilter("");
    setReviewFilter("all");
    setDetailTab("conversation");
    writeEvidenceUrl({
      session: null,
      q: null,
      tester: null,
      quality: null,
      build: null,
      platform: null,
      review: null,
      tab: null,
      reviewId: null
    });
  }, [
    applySessionNotes,
    claimNoticeRequest,
    clearReviewDraftBinding,
    user.id,
    user.role,
    user.username,
    writeEvidenceUrl
  ]);

  // Server-side search across the whole corpus. Debounced so typing stays
  // cheap; the hook drops stale responses and isolates accounts.
  useEffect(() => {
    if (!active) return;
    if (!searchActive) {
      clearSearch();
      return;
    }
    const timer = window.setTimeout(() => {
      void searchSessions(serverQuery);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [active, clearSearch, reviewFilterRevision, searchActive, searchSessions, serverQuery]);

  const incomingSessionId = location.isAdmin && location.section === "evidence" ? location.params.get("session") : null;
  const incomingFilters =
    location.isAdmin &&
    location.section === "evidence" &&
    Boolean(
      location.params.get("q") ||
      location.params.get("tester") ||
      location.params.get("quality") ||
      location.params.get("build") ||
      location.params.get("platform") ||
      location.params.get("review")
    );
  const autoSelectTargetId =
    active && !searchActive && !incomingFilters && !requestedSessionId && !incomingSessionId && !selectedSessionId
      ? visibleSessions[0]?.sessionId
      : undefined;
  useEffect(() => {
    if (!autoSelectTargetId) return;
    claimEvidenceNavigationIntent();
    // Auto-selection is a background default: on phones the list stays in
    // front until the operator actually opens a session.
    selectSession(autoSelectTargetId, { claimIntent: false, writeUrl: false, openMobileDetail: false });
  }, [autoSelectTargetId, claimEvidenceNavigationIntent, selectSession]);

  // A selection that no longer matches the active filters is deselected — but
  // its drafts were already stashed per session, so nothing is lost.
  const selectedPredicateSummary = selectedSessionId
    ? (sessionDetails[selectedSessionId] ??
      testingSessions.find((session) => session.sessionId === selectedSessionId) ??
      data.searchResults.find((session) => session.sessionId === selectedSessionId))
    : undefined;
  useEffect(() => {
    if (!selectedSessionId || requestedSessionId || !selectedPredicateSummary) return;
    const matches = sessionMatchesFilters(selectedPredicateSummary, {
      testerId: testerIdFilter,
      quality: qualityFilter,
      build: buildFilter,
      platform: platformFilter,
      reviewStatus: canReview ? reviewFilter : "all",
      reviewStatusesOfSession: reviewStatusesBySession.get(selectedPredicateSummary.sessionId)
    });
    if (matches) return;
    claimEvidenceNavigationIntent();
    clearSelectedSession();
  }, [
    buildFilter,
    canReview,
    clearSelectedSession,
    claimEvidenceNavigationIntent,
    reviewStatusesBySession,
    platformFilter,
    qualityFilter,
    requestedSessionId,
    reviewFilter,
    selectedPredicateSummary,
    selectedSessionId,
    testerIdFilter
  ]);

  useEffect(() => {
    const sessionId = selectedSessionId;
    if (!active || requestedSessionId || !sessionId) return;
    let current = true;
    setSelectionLoad({ id: sessionId, status: "loading" });
    void loadSession(sessionId).then((detail) => {
      if (current) setSelectionLoad(detail ? null : { id: sessionId, status: "unavailable" });
    });
    const timer = window.setInterval(() => void loadSession(sessionId, true), 10_000);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [active, loadSession, requestedSessionId, selectedSessionId]);

  // A clean notes draft follows the server; a stashed (dirty) draft pins.
  useEffect(() => {
    const session = selectedSession;
    if (!session || noteSessionIdRef.current !== session.sessionId || notesDirtyRef.current) return;
    writeSessionNotes(session.notes);
  }, [selectedSession, writeSessionNotes]);

  useEffect(() => {
    const sessionId = selectedSession?.sessionId;
    if (!sessionId) return;
    const binding = reviewDraftBindingRef.current;
    if (!binding || binding.sessionId !== sessionId) {
      resetReviewDraft(sessionId, selectedReview);
      return;
    }
    if (reviewDraftDirtyRef.current) return;
    if (binding.reviewId !== selectedReview?.id || binding.serverRevision !== (selectedReview?.updatedAt ?? 0)) {
      resetReviewDraft(sessionId, selectedReview);
    }
  }, [resetReviewDraft, selectedReview, selectedSession?.sessionId]);

  // A governance handoff may arrive before operations data does; bind the
  // focused review as soon as it exists, without overriding a dirty draft.
  useEffect(() => {
    if (!canReview || focusedReviewId || reviewDraftDirtyRef.current) return;
    const params = readAdminLocation().params;
    const reviewIdParam = params.get("reviewId");
    const sessionParam = params.get("session");
    if (!reviewIdParam || !sessionParam || sessionParam !== selectedSessionId) return;
    if (!operationReviews.some((review) => review.id === reviewIdParam)) return;
    setFocusedReviewId(reviewIdParam);
  }, [canReview, focusedReviewId, operationReviews, selectedSessionId]);

  useEffect(() => {
    if (!active || !requestedSessionId) return;
    let current = true;
    const navigationRequestId = claimEvidenceNavigationIntent({ retainRequestedSession: true });
    const noticeRequestId = claimNoticeRequest();
    setArmedAction(null);
    setQuery("");
    setBuildFilter("");
    setPlatformFilter("");
    setReviewFilter("all");
    setDetailTab("conversation");
    setQualityFilter(
      requestedSessionSummary?.quality === "pass" ||
        requestedSessionSummary?.quality === "watch" ||
        requestedSessionSummary?.quality === "fail"
        ? requestedSessionSummary.quality
        : "all"
    );
    setTesterIdFilter(requestedSessionSummary?.testerId ?? "");
    setSelectedSessionId(requestedSessionId);
    setFocusedReviewId(null);
    setMobileDetailOpen(true);
    resetReviewDraft(requestedSessionId, requestedReview);
    applySessionNotes(requestedSessionId, requestedSessionSummary?.notes ?? "");
    writeEvidenceUrl({
      session: requestedSessionId,
      q: null,
      build: null,
      platform: null,
      review: null,
      tab: null,
      reviewId: null,
      tester: requestedSessionSummary?.testerId ?? null,
      quality:
        requestedSessionSummary?.quality === "pass" ||
        requestedSessionSummary?.quality === "watch" ||
        requestedSessionSummary?.quality === "fail"
          ? requestedSessionSummary.quality
          : null
    });
    void loadSession(requestedSessionId).then((detail) => {
      if (!current || !ownsEvidenceNavigationIntent(navigationRequestId)) return;
      if (detail) {
        setQualityFilter(detail.quality);
        setTesterIdFilter(detail.testerId);
        applySessionNotes(detail.sessionId, detail.notes);
        writeEvidenceUrl({
          session: detail.sessionId,
          tester: detail.testerId,
          quality: detail.quality
        });
      } else {
        setOwnedNotice(noticeRequestId, {
          tone: "error",
          message: localized(
            language,
            "所选证据不可用，或已超出当前账号的访问范围。",
            "The requested evidence is unavailable or outside this account's access."
          )
        });
      }
      handledFocusRequestRef.current = focusRequestKey;
      workspaceRef.current?.focus();
      onRequestedSessionHandled(requestedSessionId);
    });
    return () => {
      current = false;
    };
  }, [
    active,
    applySessionNotes,
    claimEvidenceNavigationIntent,
    claimNoticeRequest,
    focusRequestKey,
    language,
    loadSession,
    onRequestedSessionHandled,
    ownsEvidenceNavigationIntent,
    requestedReview,
    requestedSessionId,
    requestedSessionSummary?.notes,
    requestedSessionSummary?.quality,
    requestedSessionSummary?.testerId,
    resetReviewDraft,
    setOwnedNotice,
    writeEvidenceUrl
  ]);

  useEffect(() => {
    if (!active || requestedSessionId || focusRequestKey === 0 || handledFocusRequestRef.current === focusRequestKey) {
      return;
    }
    claimEvidenceNavigationIntent();
    handledFocusRequestRef.current = focusRequestKey;
    workspaceRef.current?.focus();
  }, [active, claimEvidenceNavigationIntent, focusRequestKey, requestedSessionId]);

  // Warn before any real loss: reload/close gets a native prompt, and the
  // shell's cancelable admin:beforeleave gets a localized confirmation.
  useEffect(() => {
    if (!hasDirtyDrafts) return;
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const onAdminBeforeLeave = (event: Event) => {
      if (event.defaultPrevented) return;
      if (typeof window.confirm !== "function") return;
      const leave = window.confirm(
        localized(
          language,
          "有未保存的证据备注或复核草稿。确定丢弃并离开？",
          "You have unsaved evidence notes or review drafts. Discard them and leave?"
        )
      );
      if (!leave) event.preventDefault();
    };
    const onAdminDidLeave = () => {
      notesStashRef.current = {};
      reviewStashRef.current = {};
      notesDirtyRef.current = false;
      reviewDraftDirtyRef.current = false;
      removeDraftStore(draftStoreKey(user));
      setDraftStoreVersion((version) => version + 1);
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("admin:beforeleave", onAdminBeforeLeave);
    window.addEventListener("admin:didleave", onAdminDidLeave);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("admin:beforeleave", onAdminBeforeLeave);
      window.removeEventListener("admin:didleave", onAdminDidLeave);
    };
  }, [draftStoreVersion, hasDirtyDrafts, language, user]);

  const arm = (key: string, action: () => void) => {
    if (armedAction === key) {
      setArmedAction(null);
      action();
    } else {
      setArmedAction(key);
    }
  };

  const setFilterQuery = (value: string) => {
    claimEvidenceNavigationIntent();
    setArmedAction(null);
    setQuery(value);
    writeEvidenceUrl({ q: value || null });
  };

  const setFilterTester = (value: string) => {
    claimEvidenceNavigationIntent();
    setArmedAction(null);
    setTesterIdFilter(value);
    writeEvidenceUrl({ tester: value || null });
  };

  const setFilterQuality = (value: TestQualityFilter) => {
    claimEvidenceNavigationIntent();
    setArmedAction(null);
    setQualityFilter(value);
    writeEvidenceUrl({ quality: value === "all" ? null : value });
  };

  const setFilterBuild = (value: string) => {
    claimEvidenceNavigationIntent();
    setArmedAction(null);
    setBuildFilter(value);
    writeEvidenceUrl({ build: value || null });
  };

  const setFilterPlatform = (value: PlatformFilter) => {
    claimEvidenceNavigationIntent();
    setArmedAction(null);
    setPlatformFilter(value);
    writeEvidenceUrl({ platform: value || null });
  };

  const setFilterReviewStatus = (value: ReviewStatusFilter) => {
    claimEvidenceNavigationIntent();
    setArmedAction(null);
    setReviewFilter(value);
    writeEvidenceUrl({ review: value === "all" ? null : value });
  };

  const resetFilters = () => {
    claimEvidenceNavigationIntent();
    setArmedAction(null);
    setQuery("");
    setTesterIdFilter("");
    setQualityFilter("all");
    setBuildFilter("");
    setPlatformFilter("");
    setReviewFilter("all");
    writeEvidenceUrl({ q: null, tester: null, quality: null, build: null, platform: null, review: null });
  };

  const setDetailTabWithUrl = (tab: DetailTab) => {
    setDetailTab(tab);
    writeEvidenceUrl({ tab: tab === "conversation" ? null : tab });
  };

  const purgeDraftsForSessions = (sessionIds: string[]) => {
    let changed = false;
    for (const sessionId of sessionIds) {
      if (sessionId in notesStashRef.current) {
        delete notesStashRef.current[sessionId];
        changed = true;
      }
      if (sessionId in reviewStashRef.current) {
        delete reviewStashRef.current[sessionId];
        changed = true;
      }
    }
    if (changed) persistDrafts();
  };

  const selectReviewEvidence = async (review: TestingReview) => {
    const requestId = claimEvidenceNavigationIntent();
    const noticeRequestId = claimNoticeRequest();
    const sessionId = review.sessionId;
    const session = sessionDetails[sessionId] ?? testingSessions.find((item) => item.sessionId === sessionId);
    setArmedAction(null);
    setQuery("");
    setBuildFilter("");
    setPlatformFilter("");
    setReviewFilter("all");
    setQualityFilter(session?.quality ?? "all");
    setTesterIdFilter(session?.testerId ?? "");
    const bound = editableReview(review) ?? findEditableReview(operationReviews, sessionId);
    selectSession(sessionId, { claimIntent: false, review: bound, writeUrl: false });
    writeEvidenceUrl({
      q: null,
      build: null,
      platform: null,
      review: null,
      tester: session?.testerId ?? null,
      quality: session?.quality ?? null,
      session: sessionId,
      reviewId: bound?.id ?? null
    });
    if (session) return;
    const detail = await data.loadSession(sessionId);
    if (!ownsEvidenceNavigationIntent(requestId)) return;
    if (!detail) {
      setOwnedNotice(noticeRequestId, {
        tone: "error",
        message: localized(
          language,
          "复核记录关联的证据不可用，或已超出当前账号的访问范围。",
          "The evidence linked to this review is unavailable or outside this account's access."
        )
      });
      return;
    }
    setQualityFilter(detail.quality);
    setTesterIdFilter(detail.testerId);
    applySessionNotes(detail.sessionId, detail.notes);
    writeEvidenceUrl({ session: detail.sessionId, tester: detail.testerId, quality: detail.quality });
  };

  const runClear = async (key: string, payload: TestingClearScope, targetLabel: string, purgedSessionIds: string[]) => {
    claimEvidenceNavigationIntent();
    const noticeRequestId = claimNoticeRequest();
    setBusyAction(key);
    const ok = await data.clearEvidence(payload);
    if (ok) {
      purgeDraftsForSessions(purgedSessionIds);
      if (payload.scope === "all") {
        notesStashRef.current = {};
        reviewStashRef.current = {};
        persistDrafts();
      }
      clearReviewDraftBinding();
      setSelectedSessionId(null);
      setFocusedReviewId(null);
      setMobileDetailOpen(false);
      noteSessionIdRef.current = null;
      notesDirtyRef.current = false;
      setNotesDirty(false);
      writeSessionNotes("");
      writeEvidenceUrl({ session: null, reviewId: null });
      await agent.refreshHealth();
      setOwnedNotice(noticeRequestId, {
        tone: "success",
        message: localized(language, `已清除 ${targetLabel}。`, `Cleared ${targetLabel}.`)
      });
      if (searchActive) void searchSessions(serverQuery);
    } else {
      setOwnedNotice(noticeRequestId, {
        tone: "error",
        message: localized(
          language,
          `清除 ${targetLabel} 失败。需要管理员权限，并请确认中继在线。`,
          `Failed to clear ${targetLabel}. Administrator permission is required and the relay must be online.`
        )
      });
    }
    setBusyAction(null);
  };

  const loadMoreEvidence = async () => {
    setLoadingMore(true);
    await data.loadMore();
    setLoadingMore(false);
  };

  const searchMoreEvidence = async () => {
    setLoadingMore(true);
    await searchSessions({ ...serverQuery, cursor: data.searchCursor });
    setLoadingMore(false);
  };

  const saveSessionNotes = async () => {
    if (!selectedSession) return;
    const submittedSessionId = selectedSession.sessionId;
    const submittedNotes = sessionNotesRef.current;
    const requestId = ++noteSaveRequestRef.current;
    const noticeRequestId = claimNoticeRequest();
    setPendingNoteSave({ requestId, sessionId: submittedSessionId, notes: submittedNotes });
    const ok = await data.saveNotes(submittedSessionId, submittedNotes);
    const ownsCurrentDraft =
      noteSessionIdRef.current === submittedSessionId && sessionNotesRef.current === submittedNotes;
    if (ok && ownsCurrentDraft) {
      notesDirtyRef.current = false;
      setNotesDirty(false);
    }
    if (ok && notesStashRef.current[submittedSessionId] === submittedNotes) {
      delete notesStashRef.current[submittedSessionId];
      persistDrafts();
    }
    if (requestId === noteSaveRequestRef.current && noteSessionIdRef.current === submittedSessionId) {
      setOwnedNotice(noticeRequestId, {
        tone: ok ? "success" : "error",
        message: ok
          ? localized(language, "证据备注已保存并写入审计记录。", "Evidence notes saved and recorded in the audit log.")
          : localized(
              language,
              "证据备注保存失败；请确认审核员权限和中继状态。",
              "Failed to save evidence notes; check reviewer permission and relay status."
            )
      });
    }
    setPendingNoteSave((current) => (current?.requestId === requestId ? null : current));
  };

  const beginReviewMutation = (target: Exclude<ReviewBusyTarget, null>): ReviewMutationRequest => {
    const key = reviewBusyTargetKey(target);
    const requestId = ++reviewMutationSequenceRef.current;
    const noticeRequestId = claimNoticeRequest();
    reviewTargetRequestRef.current.set(key, requestId);
    setReviewBusyTargets((current) => new Set(current).add(key));
    return { key, requestId, noticeRequestId };
  };

  const ownsReviewMutation = ({ key, requestId }: ReviewMutationRequest) =>
    reviewTargetRequestRef.current.get(key) === requestId;

  const finishReviewMutation = (request: ReviewMutationRequest) => {
    if (!ownsReviewMutation(request)) return;
    reviewTargetRequestRef.current.delete(request.key);
    setReviewBusyTargets((current) => {
      if (!current.has(request.key)) return current;
      const next = new Set(current);
      next.delete(request.key);
      return next;
    });
  };

  const saveReview = async (
    input: Partial<TestingReview> & { sessionId: string },
    target: Exclude<ReviewBusyTarget, null>,
    submittedDraft?: { binding: ReviewDraftBinding; fields: ReviewDraftFields }
  ) => {
    const request = beginReviewMutation(target);
    try {
      const result = await data.saveReview(input);
      if (result.ok) {
        if (submittedDraft && ownsReviewMutation(request)) {
          const stash = reviewStashRef.current[submittedDraft.binding.sessionId];
          if (
            stash &&
            stash.reviewId === submittedDraft.binding.reviewId &&
            stash.serverRevision === submittedDraft.binding.serverRevision &&
            sameReviewDraft(stash.fields, submittedDraft.fields)
          ) {
            delete reviewStashRef.current[submittedDraft.binding.sessionId];
            persistDrafts();
          }
        }
        const currentBinding = reviewDraftBindingRef.current;
        if (
          submittedDraft &&
          ownsReviewMutation(request) &&
          currentBinding?.generation === submittedDraft.binding.generation &&
          currentBinding.sessionId === submittedDraft.binding.sessionId &&
          currentBinding.reviewId === submittedDraft.binding.reviewId &&
          sameReviewDraft(reviewDraftRef.current, submittedDraft.fields)
        ) {
          resetReviewDraft(submittedDraft.binding.sessionId, result.data);
        }
        if (ownsReviewMutation(request)) {
          setOwnedNotice(request.noticeRequestId, {
            tone: "success",
            message: localized(
              language,
              "复核记录已保存并写入审计日志。",
              "Review saved and recorded in the audit log."
            )
          });
          await data.refresh();
        }
      } else {
        if (ownsReviewMutation(request)) {
          setOwnedNotice(request.noticeRequestId, { tone: "error", message: result.error.message });
        }
      }
    } finally {
      finishReviewMutation(request);
    }
  };

  const submitReview = async () => {
    if (!selectedSession) return;
    if (!reviewDraftBindingRef.current || reviewDraftBindingRef.current.sessionId !== selectedSession.sessionId) {
      resetReviewDraft(selectedSession.sessionId, selectedReview);
    }
    const currentBinding = reviewDraftBindingRef.current;
    if (!currentBinding) return;
    if (currentBinding.reviewId !== selectedReview?.id) {
      const noticeRequestId = claimNoticeRequest();
      setOwnedNotice(noticeRequestId, {
        tone: "error",
        message: localized(
          language,
          "复核记录已变化，请先采用最新复核，再继续编辑。",
          "The review changed. Adopt the latest review before continuing to edit."
        )
      });
      return;
    }
    const submittedBinding = { ...currentBinding };
    const submittedFields = { ...reviewDraftRef.current };
    await saveReview(
      {
        id: submittedBinding.reviewId,
        sessionId: selectedSession.sessionId,
        runId: selectedSession.runId,
        status: submittedBinding.reviewId ? (selectedReview?.status ?? "open") : "open",
        severity: submittedFields.severity,
        owner: submittedFields.owner.trim() || user.username,
        title: submittedFields.title.trim() || localized(language, "会话需要复核", "Session needs review"),
        comment: submittedFields.comment.trim()
      },
      { kind: "composer", sessionId: selectedSession.sessionId },
      { binding: submittedBinding, fields: submittedFields }
    );
  };

  const changeReviewStatus = async (review: TestingReview, status: TestingReviewStatus) => {
    await saveReview(
      {
        id: review.id,
        sessionId: review.sessionId,
        status,
        ...(status === "resolved" ? { resolution: localized(language, "已复核", "Reviewed") } : {})
      },
      { kind: "status", reviewId: review.id }
    );
  };

  const changeReviewDraft = <Key extends keyof ReviewDraftFields>(key: Key, value: ReviewDraftFields[Key]) => {
    reviewDraftDirtyRef.current = true;
    reviewDraftRef.current = { ...reviewDraftRef.current, [key]: value };
    const binding = reviewDraftBindingRef.current;
    const sessionId = binding?.sessionId ?? selectedSession?.sessionId;
    if (sessionId) {
      reviewStashRef.current[sessionId] = {
        fields: reviewDraftRef.current,
        reviewId: binding?.reviewId,
        serverRevision: binding?.serverRevision ?? 0
      };
      persistDrafts();
    }
    if (key === "title") setReviewTitle(value as string);
    if (key === "comment") setReviewComment(value as string);
    if (key === "severity") setReviewSeverity(value as TestingReviewSeverity);
    if (key === "owner") setReviewOwner(value as string);
  };

  const adoptLatestReview = () => {
    if (!selectedSession) return;
    claimNoticeRequest();
    delete reviewStashRef.current[selectedSession.sessionId];
    persistDrafts();
    resetReviewDraft(selectedSession.sessionId, selectedReview);
  };

  const reviewComposerBusy = selectedSession
    ? reviewBusyTargets.has(`review-composer:${selectedSession.sessionId}`)
    : false;

  const noticeElement = notice ? (
    <p className={`adminNotice ${notice.tone}`} role="status">
      {notice.message}
    </p>
  ) : null;

  const resultListStatus = searchActive
    ? data.searchStatus === "ready" || data.searchStatus === "error"
      ? data.searchStatus
      : "loading"
    : data.status === "loading" && !testingSessions.length
      ? "loading"
      : "ready";

  const resultCountLabel = searchActive
    ? data.searchStatus === "loading"
      ? localized(language, "正在搜索全部证据…", "Searching all evidence…")
      : data.searchStatus === "error"
        ? localized(language, "搜索失败。", "Search failed.")
        : localized(
            language,
            `服务器匹配 ${data.searchTotal} 条 · 已显示 ${visibleSessions.length}`,
            `${data.searchTotal} matching on server · ${visibleSessions.length} shown`
          )
    : localized(
        language,
        `已加载 ${testingSessions.length}/${data.sessionTotal}`,
        `Loaded ${testingSessions.length}/${data.sessionTotal}`
      );

  const testerClearIds = selectedTester
    ? testingSessions.filter((session) => session.testerKey === selectedTester.testerKey).map((s) => s.sessionId)
    : [];

  if (!testing) {
    return (
      <section
        ref={workspaceRef}
        className="adminSectionCard testingPanel"
        aria-label="证据与问题"
        aria-busy={data.status === "loading"}
        hidden={!active}
        inert={!active ? true : undefined}
        tabIndex={-1}
      >
        <p className="adminWorkspaceLoading">
          {data.status === "loading"
            ? localized(language, "正在加载证据与问题…", "Loading evidence and issues…")
            : localized(language, "暂无可用证据数据。", "No evidence data available.")}
        </p>
      </section>
    );
  }

  return (
    <section
      ref={workspaceRef}
      className="adminSectionCard testingPanel"
      aria-label="证据与问题"
      hidden={!active}
      inert={!active ? true : undefined}
      tabIndex={-1}
    >
      <div className="panelHeader">
        <div>
          <h2>{localized(language, "证据与问题", "Evidence & issues")}</h2>
          <span>
            {testing
              ? `${testing.windowMinutes} ${localized(language, "分钟", "min")} · ${testing.users.length} ${localized(language, "位测试员", "testers")}`
              : localized(language, "等待证据", "Waiting for evidence")}
            {agent.health?.build ? ` · ${localized(language, "构建", "Build")} ${agent.health.build.gitCommit}` : ""}
          </span>
        </div>
        <div className="panelActions">
          <span>
            {corpusIssueCount(testerUsers)} {localized(language, "项待复核", "to review")}
          </span>
          <button
            type="button"
            onClick={() => exportTestingReport(agent.health, agent.testerId, agent.testerRegion, testing)}
          >
            {localized(language, "导出统计", "Export stats")}
          </button>
          <details className="evidenceTools">
            <summary>{localized(language, "更多操作", "More actions")}</summary>
            <div className="evidenceToolsMenu">
              <button
                type="button"
                className={`danger adminDanger ${armedAction === "clear-all" ? "armed" : ""}`}
                disabled={busyAction !== null || !testerUsers.length || !canClear}
                title={
                  canClear ? undefined : localized(language, "需要管理员权限", "Administrator permission required")
                }
                onClick={() =>
                  arm(
                    "clear-all",
                    () =>
                      void runClear(
                        "clear-all",
                        { scope: "all" },
                        localized(language, "全部测试证据", "all testing evidence"),
                        Object.keys(notesStashRef.current).concat(Object.keys(reviewStashRef.current))
                      )
                  )
                }
              >
                {armedAction === "clear-all"
                  ? confirmationCopy(
                      "all-evidence",
                      localized(language, "全部测试证据", "all testing evidence"),
                      language
                    )
                  : localized(language, "清除全部证据", "Clear all evidence")}
              </button>
            </div>
          </details>
        </div>
      </div>

      {selectedSession ? null : noticeElement}

      <div className="testingFilterBar">
        <label className="evidenceSearchInput">
          <span>{localized(language, "搜索证据", "Search evidence")}</span>
          <input
            value={query}
            onChange={(event) => setFilterQuery(event.target.value)}
            placeholder={localized(
              language,
              "转写、用例、设备、构建或备注…",
              "Transcripts, cases, devices, builds, notes…"
            )}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label>
          <span>{localized(language, "测试员", "Tester")}</span>
          <select value={testerIdFilter} onChange={(event) => setFilterTester(event.target.value)}>
            <option value="">{localized(language, "全部测试员", "All testers")}</option>
            {agent.testerId ? (
              <option value={agent.testerId}>
                {localized(language, "当前测试员", "Current tester")} · {agent.testerId}
              </option>
            ) : null}
            {testerUsers.map((tester) => (
              <option key={tester.testerKey} value={tester.testerId}>
                {tester.testerId}
              </option>
            ))}
          </select>
        </label>
        <div
          className="qualityFilter"
          role="group"
          aria-label={localized(language, "会话质量筛选", "Session quality filter")}
        >
          {TEST_QUALITY_FILTERS.map((quality) => (
            <button
              key={quality}
              type="button"
              className={qualityFilter === quality ? "active" : ""}
              aria-pressed={qualityFilter === quality}
              onClick={() => setFilterQuality(quality)}
            >
              {testQualityLabel(quality, language)}
            </button>
          ))}
        </div>
        <details className="adminCollapsible evidenceFilters">
          <summary>
            {localized(language, "更多筛选", "More filters")}
            {searchActive || testerIdFilter ? ` · ${resultCountLabel}` : ""}
          </summary>
          <div className="evidenceFiltersBody">
            <label>
              <span>{localized(language, "构建", "Build")}</span>
              <input
                value={buildFilter}
                onChange={(event) => setFilterBuild(event.target.value)}
                placeholder={localized(language, "版本或提交", "Version or commit")}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label>
              <span>{localized(language, "平台", "Platform")}</span>
              <select
                value={platformFilter}
                onChange={(event) => setFilterPlatform(event.target.value as PlatformFilter)}
              >
                {PLATFORM_FILTERS.map((platform) => (
                  <option key={platform || "all"} value={platform}>
                    {platform ? platform.toUpperCase() : localized(language, "全部", "All")}
                  </option>
                ))}
              </select>
            </label>
            {canReview ? (
              <label>
                <span>{localized(language, "复核状态", "Review status")}</span>
                <select
                  value={reviewFilter}
                  onChange={(event) => setFilterReviewStatus(event.target.value as ReviewStatusFilter)}
                >
                  {REVIEW_STATUS_FILTERS.map((status) => (
                    <option key={status} value={status}>
                      {status === "all"
                        ? localized(language, "全部", "All")
                        : testingReviewStatusLabel(status, language)}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <button
              type="button"
              className="evidenceFilterReset"
              onClick={resetFilters}
              disabled={!searchActive && testerIdFilter === ""}
            >
              {localized(language, "重置筛选", "Reset filters")}
            </button>
            <div className="historyRetention">
              <span>{localized(language, "证据历史", "Evidence history")}</span>
              <strong>
                {testing?.history.persistent
                  ? localized(language, "持久化", "Persistent")
                  : localized(language, "内存", "Memory")}{" "}
                · {resultCountLabel}
              </strong>
            </div>
          </div>
        </details>
      </div>

      <div className={`sessionReplayGrid adminDataSplit ${mobileDetailOpen ? "showDetail" : ""}`}>
        <div className="sessionList" aria-label={localized(language, "证据会话列表", "Evidence session list")}>
          <p className={`evidenceResultCount ${resultListStatus}`} role="status">
            {resultListStatus === "loading"
              ? localized(language, "正在检索…", "Retrieving…")
              : resultListStatus === "error"
                ? `${localized(language, "搜索失败。", "Search failed.")}${data.searchError ? ` ${data.searchError.message}` : ""}`
                : resultCountLabel}
          </p>
          {visibleSessions.length ? (
            visibleSessions.map((session) => {
              const issues = sessionIssueCount(session);
              return (
                <button
                  className={`sessionButton ${selectedSessionId === session.sessionId ? "active" : ""}`}
                  key={session.sessionId}
                  type="button"
                  onClick={() => selectSession(session.sessionId)}
                >
                  <span className={`sessionQuality ${testQualityClass(session.quality)}`}>
                    {testQualityLabel(session.quality, language)}
                  </span>
                  <strong>{formatSessionDate(session.startedAt, language)}</strong>
                  <span>{session.testCaseName}</span>
                  <span>{session.testerId}</span>
                  <span>
                    {formatDuration(session.durationMs)} · {session.platform} ·{" "}
                    {latencyLabel(session.latencySamples, session.p95LatencyMs)} P95
                  </span>
                  <span>
                    {localized(language, "评分", "Score")} {session.evaluation.score} · {issues}{" "}
                    {localized(language, "个问题", "issues")}
                  </span>
                  <span>
                    {session.validity.status === "valid"
                      ? localized(language, "有效证据", "Valid evidence")
                      : session.validity.detail}
                  </span>
                </button>
              );
            })
          ) : resultListStatus === "loading" ? (
            <p className="testerConversationEmpty">{localized(language, "正在检索证据…", "Retrieving evidence…")}</p>
          ) : searchActive ? (
            <p className="testerConversationEmpty">
              {localized(
                language,
                "没有匹配的会话。尝试更短的关键词或重置筛选。",
                "No matching sessions. Try a shorter keyword or reset the filters."
              )}
            </p>
          ) : data.sessionTotal === 0 ? (
            <p className="testerConversationEmpty">
              {localized(
                language,
                "暂无测试证据。完成测试后，这里会汇总全部会话。",
                "No testing evidence yet. Completed sessions will appear here."
              )}
            </p>
          ) : (
            <p className="testerConversationEmpty">
              {localized(language, "当前视图没有匹配的已完成会话。", "No completed sessions match this view.")}
            </p>
          )}
          {searchActive ? (
            data.searchCursor ? (
              <button
                type="button"
                className="loadMoreEvidence"
                disabled={loadingMore}
                onClick={() => void searchMoreEvidence()}
              >
                {loadingMore
                  ? localized(language, "正在加载…", "Loading…")
                  : localized(
                      language,
                      `加载更多结果（已显示 ${visibleSessions.length}/${data.searchTotal}）`,
                      `Load more results (${visibleSessions.length}/${data.searchTotal} shown)`
                    )}
              </button>
            ) : null
          ) : data.nextCursor ? (
            <button
              type="button"
              className="loadMoreEvidence"
              disabled={loadingMore}
              onClick={() => void loadMoreEvidence()}
            >
              {loadingMore
                ? localized(language, "正在加载…", "Loading…")
                : localized(
                    language,
                    `加载更多证据（${testingSessions.length}/${data.sessionTotal}）`,
                    `Load more evidence (${testingSessions.length}/${data.sessionTotal})`
                  )}
            </button>
          ) : null}
        </div>
        <div className="sessionDetail">
          <button
            type="button"
            className="evidenceBackToResults"
            onClick={() => {
              setMobileDetailOpen(false);
              window.requestAnimationFrame(() => {
                const list = workspaceRef.current?.querySelector<HTMLElement>(".sessionReplayGrid > .sessionList");
                list?.scrollIntoView({ block: "start" });
                list?.querySelector<HTMLElement>(".sessionButton.active")?.focus({ preventScroll: true });
              });
            }}
            hidden={!selectedSessionId}
          >
            {localized(language, "‹ 返回结果列表", "‹ Back to results")}
          </button>
          {selectedSession ? (
            <>
              <div className="evidenceDetailHead">
                <div>
                  <span>{localized(language, "会话回放", "Session replay")}</span>
                  <strong>{formatSessionDate(selectedSession.startedAt, language)}</strong>
                  <p>
                    {selectedSession.campaignName} · {selectedSession.testCaseName} · {selectedSession.testerId} ·{" "}
                    {formatDuration(selectedSession.durationMs)} · {selectedSessionIssues}{" "}
                    {localized(language, "个问题", "issues")}
                  </p>
                </div>
                <div className="testerConversationActions">
                  <button
                    type="button"
                    onClick={() => selectedSession && exportTestingSession(selectedSession)}
                    disabled={!selectedSession}
                  >
                    {localized(language, "导出会话", "Export session")}
                  </button>
                  <button
                    type="button"
                    className={`danger adminDanger ${armedAction === `clear-session:${selectedSession.sessionId}` ? "armed" : ""}`}
                    disabled={busyAction !== null || !canClear}
                    title={
                      canClear ? undefined : localized(language, "需要管理员权限", "Administrator permission required")
                    }
                    onClick={() => {
                      const key = `clear-session:${selectedSession.sessionId}`;
                      arm(
                        key,
                        () =>
                          void runClear(
                            key,
                            { scope: "session", sessionId: selectedSession.sessionId },
                            localized(
                              language,
                              `会话 ${selectedSession.sessionId}`,
                              `session ${selectedSession.sessionId}`
                            ),
                            [selectedSession.sessionId]
                          )
                      );
                    }}
                  >
                    {armedAction === `clear-session:${selectedSession.sessionId}`
                      ? confirmationCopy("session", selectedSession.sessionId, language)
                      : localized(language, "删除会话", "Delete session")}
                  </button>
                </div>
              </div>
              {noticeElement}
              <div
                className="evidenceTabs"
                role="tablist"
                aria-label={localized(language, "会话视图", "Session view")}
                onKeyDown={(event) => {
                  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
                  const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
                  const next =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? tabs.length - 1
                        : (index + (event.key === "ArrowLeft" ? -1 : 1) + tabs.length) % tabs.length;
                  event.preventDefault();
                  tabs[next]?.focus();
                  tabs[next]?.click();
                }}
              >
                {(["conversation", "diagnostics", ...(canReview ? (["review"] as const) : [])] as DetailTab[]).map(
                  (tab) => (
                    <button
                      key={tab}
                      type="button"
                      role="tab"
                      id={`evidence-tab-${tab}`}
                      aria-controls={`evidence-panel-${tab}`}
                      tabIndex={detailTab === tab ? 0 : -1}
                      className={detailTab === tab ? "active" : ""}
                      aria-selected={detailTab === tab}
                      onClick={() => setDetailTabWithUrl(tab)}
                    >
                      {tab === "conversation"
                        ? localized(language, "对话", "Conversation")
                        : tab === "diagnostics"
                          ? localized(language, "诊断", "Diagnostics")
                          : localized(language, "复核", "Review")}
                    </button>
                  )
                )}
              </div>
              <div
                role="tabpanel"
                className="evidenceTabPanel"
                id={`evidence-panel-${detailTab}`}
                aria-labelledby={`evidence-tab-${detailTab}`}
              >
                {detailTab === "conversation" ? (
                  <div className="sessionTranscriptList">
                    {selectedSessionTurns.length ? (
                      selectedSessionTurns.map((turn, index) => (
                        <article
                          className={`testerTurn ${turn.speaker}`}
                          key={`${turn.sessionId}-${turn.at}-${turn.speaker}-${index}`}
                        >
                          <div>
                            <strong>{turn.speaker === "rider" ? localized(language, "骑手", "Rider") : "Max"}</strong>
                            <span>
                              {formatClockTime(turn.at)} ·{" "}
                              {turn.final ? localized(language, "最终", "Final") : localized(language, "实时", "Live")}
                            </span>
                            {turn.feedback ? <span className="turnFlagChip">⚑ {turn.feedback}</span> : null}
                          </div>
                          <p>{turn.text}</p>
                        </article>
                      ))
                    ) : (
                      <p className="testerConversationEmpty">
                        {localized(language, "此会话没有转写内容。", "This session has no transcript.")}
                      </p>
                    )}
                  </div>
                ) : null}
                {detailTab === "diagnostics" ? (
                  <>
                    <div className="sessionMetricGrid">
                      <span>
                        <b>{testQualityLabel(selectedSession.quality, language)}</b>
                        {localized(language, "质量", "Quality")}
                      </span>
                      <span>
                        <b>{formatBytes(selectedSession.audioUpBytes)}</b>
                        {localized(language, "麦克风上行", "Mic uplink")}
                      </span>
                      <span>
                        <b>{formatBytes(selectedSession.audioDownBytes + selectedSession.controlDownBytes)}</b>
                        {localized(language, "下行", "Downlink")}
                      </span>
                      <span>
                        <b>
                          {latencyLabel(selectedSession.latencySamples, selectedSession.avgLatencyMs)} /{" "}
                          {latencyLabel(selectedSession.latencySamples, selectedSession.p95LatencyMs)}
                        </b>
                        {localized(language, "平均 / P95", "Avg / P95")}
                      </span>
                      <span>
                        <b>{selectedSession.errorEvents}</b>
                        {localized(language, "错误", "Errors")}
                      </span>
                      <span>
                        <b>{selectedSession.ttsFallbacks}</b>
                        {localized(language, "TTS 回退", "TTS fallback")}
                      </span>
                      <span>
                        <b>{selectedSession.evaluation.score}</b>
                        {localized(language, "评估分数", "Score")}
                      </span>
                      <span>
                        <b>{selectedSessionIssues}</b>
                        {localized(language, "问题", "Issues")}
                      </span>
                      <span>
                        <b>
                          {selectedSession.validity.status === "valid"
                            ? localized(language, "有效", "Valid")
                            : localized(language, "无效", "Invalid")}
                        </b>
                        {localized(language, "证据", "Evidence")}
                      </span>
                      <span>
                        <b>{selectedSession.deviceLabel}</b>
                        {localized(language, "设备", "Device")}
                      </span>
                      <span>
                        <b>{selectedSession.browserLanguage}</b>
                        {localized(language, "浏览器", "Browser")}
                      </span>
                      <span>
                        <b>{selectedSession.networkType}</b>
                        {localized(language, "网络", "Network")}
                      </span>
                      <span>
                        <b>{selectedSession.platform}</b>
                        {localized(language, "平台", "Platform")}
                      </span>
                      <span>
                        <b>
                          {selectedSession.appVersion} · {selectedSession.gitCommit}
                        </b>
                        {localized(language, "构建", "Build")}
                      </span>
                      <span>
                        <b>{selectedSession.policyVersion}</b>
                        {localized(language, "捕获策略", "Capture policy")}
                      </span>
                      <span
                        className={`integrity-${selectedSession.evidenceIntegrity}`}
                        title={selectedSession.evidenceHash}
                      >
                        <b>
                          {selectedSession.evidenceIntegrity} · {selectedSession.evidenceHash.slice(0, 12)}…
                        </b>
                        {localized(language, "证据 SHA-256", "Evidence SHA-256")}
                      </span>
                      <span>
                        <b>
                          {selectedSession.audioQuality.outgoingFps}fps / {selectedSession.audioQuality.droppedFrames}{" "}
                          {localized(language, "丢帧", "dropped")}
                        </b>
                        {localized(language, "音频传输", "Audio transport")}
                      </span>
                      <span>
                        <b>
                          {selectedSession.audioQuality.clippingPct}% {localized(language, "削波", "clipping")} /{" "}
                          {selectedSession.audioQuality.silencePct}% {localized(language, "静音", "silence")}
                        </b>
                        {localized(language, "信号质量", "Signal quality")}
                      </span>
                    </div>
                    {selectedSession.capturedEvaluation.score !== selectedSession.evaluation.score ||
                    selectedSession.capturedEvaluation.quality !== selectedSession.evaluation.quality ? (
                      <p className="evaluationDriftNotice">
                        {localized(language, "捕获结果", "Captured")}{" "}
                        {selectedSession.capturedEvaluation.quality.toUpperCase()} /{" "}
                        {selectedSession.capturedEvaluation.score}；
                        {localized(language, "当前策略回放", "current policy replay")}{" "}
                        {selectedSession.evaluation.quality.toUpperCase()} / {selectedSession.evaluation.score}。
                      </p>
                    ) : null}
                    <div className="sessionFlags">
                      {selectedSession.flags.length ? (
                        selectedSession.flags.map((flag) => <span key={flag}>{flag}</span>)
                      ) : (
                        <span>{localized(language, "无标记", "No flags")}</span>
                      )}
                    </div>
                    <div className="evaluationList">
                      {selectedSession.evaluation.checks.map((check) => (
                        <div className={`evaluationCheck ${check.status}`} key={check.id}>
                          <strong>{check.label}</strong>
                          <span>{check.status.toUpperCase()}</span>
                          <p>{check.detail}</p>
                        </div>
                      ))}
                    </div>
                  </>
                ) : null}
                {canReview && detailTab === "review" ? (
                  <div className="issueWorkbench evidenceReviewTab">
                    <div className="reviewComposer">
                      <span>{localized(language, "所选证据", "Selected evidence")}</span>
                      <strong>
                        {selectedSession
                          ? `${selectedSession.testCaseName} · ${selectedSession.testerId}`
                          : localized(language, "请先选择会话", "Select a session first")}
                      </strong>
                      <div className="reviewFields">
                        <label>
                          <span>{localized(language, "严重程度", "Severity")}</span>
                          <select
                            value={reviewSeverity}
                            onChange={(event) =>
                              changeReviewDraft("severity", event.target.value as TestingReviewSeverity)
                            }
                          >
                            {REVIEW_SEVERITIES.map((severity) => (
                              <option key={severity} value={severity}>
                                {testingReviewSeverityLabel(severity, language)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          <span>{localized(language, "负责人", "Owner")}</span>
                          <input
                            value={reviewOwner}
                            onChange={(event) => changeReviewDraft("owner", event.target.value)}
                          />
                        </label>
                        <label className="wide">
                          <span>{localized(language, "标题", "Title")}</span>
                          <input
                            value={reviewTitle}
                            onChange={(event) => changeReviewDraft("title", event.target.value)}
                          />
                        </label>
                        <label className="wide">
                          <span>{localized(language, "审核意见", "Comment")}</span>
                          <textarea
                            value={reviewComment}
                            onChange={(event) => changeReviewDraft("comment", event.target.value)}
                            placeholder={localized(
                              language,
                              "记录复现步骤、预期行为与处置结论…",
                              "Repro steps, expected behavior, and resolution…"
                            )}
                          />
                        </label>
                      </div>
                      {reviewBindingConflict ? (
                        <div className="reviewDraftConflict" role="status">
                          <span>
                            {localized(
                              language,
                              "复核记录已变化；当前草稿尚未应用到最新记录。",
                              "The review changed; this draft has not been applied to the latest record."
                            )}
                          </span>
                          <button type="button" onClick={adoptLatestReview}>
                            {localized(language, "采用最新复核", "Adopt latest review")}
                          </button>
                        </div>
                      ) : null}
                      <button type="button" disabled={reviewComposerBusy} onClick={() => void submitReview()}>
                        {reviewComposerBusy
                          ? localized(language, "正在保存…", "Saving…")
                          : selectedReview
                            ? localized(language, "更新复核", "Update review")
                            : localized(language, "新建复核", "New review")}
                      </button>
                    </div>
                    <div className="evidenceNotes">
                      <label>
                        <span>{localized(language, "审核证据备注", "Evidence notes")}</span>
                        <textarea
                          value={sessionNotes}
                          onChange={(event) => {
                            if (!selectedSession) return;
                            const value = event.target.value;
                            if (value === selectedSession.notes) {
                              delete notesStashRef.current[selectedSession.sessionId];
                              notesDirtyRef.current = false;
                              setNotesDirty(false);
                            } else {
                              notesStashRef.current[selectedSession.sessionId] = value;
                              notesDirtyRef.current = true;
                              setNotesDirty(true);
                            }
                            persistDrafts();
                            writeSessionNotes(value);
                          }}
                          placeholder={localized(
                            language,
                            "复现上下文、设备条件和调查记录…",
                            "Repro context, device conditions, investigation notes…"
                          )}
                        />
                      </label>
                      <button
                        type="button"
                        disabled={
                          currentDraftIsSaving ||
                          !notesDirty ||
                          busyAction === `clear-session:${selectedSession.sessionId}`
                        }
                        onClick={() => void saveSessionNotes()}
                      >
                        {currentDraftIsSaving
                          ? localized(language, "正在保存…", "Saving…")
                          : localized(language, "保存备注", "Save notes")}
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            </>
          ) : selectedSessionId ? (
            <div className="testerConversationEmpty" role="status">
              <strong>
                {selectionLoad?.id === selectedSessionId && selectionLoad.status === "unavailable"
                  ? localized(language, "所选证据不可用", "Selected evidence unavailable")
                  : localized(language, "正在加载所选证据…", "Loading selected evidence…")}
              </strong>
              {selectionLoad?.id === selectedSessionId && selectionLoad.status === "unavailable" ? (
                <p>
                  {localized(
                    language,
                    "该会话不存在、已删除，或当前账号无权访问。",
                    "This session does not exist, was removed, or is outside this account's access."
                  )}
                </p>
              ) : null}
            </div>
          ) : (
            <p className="testerConversationEmpty">
              {localized(
                language,
                "选择左侧会话即可回放转写、查看诊断并发起复核。",
                "Pick a session to replay its transcript, inspect diagnostics, and file reviews."
              )}
            </p>
          )}
          {canReview && detailTab === "review" ? (
            <div className="reviewQueue">
              {operationReviews.map((review) => (
                <article key={review.id} className={`reviewRow ${review.severity}`}>
                  <button
                    type="button"
                    className="reviewEvidenceLink"
                    onClick={() => void selectReviewEvidence(review)}
                  >
                    <span>
                      {testingReviewSeverityLabel(review.severity, language)} ·{" "}
                      {testingReviewStatusLabel(review.status, language)}
                    </span>
                    <strong>{review.title}</strong>
                    <small>
                      {review.owner} · {formatAdminRelativeTime(review.updatedAt, language)}
                    </small>
                  </button>
                  <p>{review.comment || localized(language, "暂无审核意见。", "No review comment.")}</p>
                  <select
                    aria-label={`${localized(language, "复核状态", "Review status")} ${review.title}`}
                    value={review.status}
                    disabled={reviewBusyTargets.has(`review-status:${review.id}`)}
                    onChange={(event) => void changeReviewStatus(review, event.target.value as TestingReviewStatus)}
                  >
                    {REVIEW_STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {testingReviewStatusLabel(status, language)}
                      </option>
                    ))}
                  </select>
                </article>
              ))}
              {!operationReviews.length ? (
                <p className="testerConversationEmpty">
                  {localized(language, "复核队列当前为空。", "The review queue is empty.")}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <details className="adminCollapsible evidenceAggregate">
        <summary>
          {localized(language, "测试员总览、历史与聚合诊断", "Testers, history & aggregate diagnostics")}
        </summary>
        <div className="statGrid">
          <span>
            <b>{testingTotals?.activeTestSessions ?? agent.health?.metrics?.activeSessions ?? 0}</b>
            {localized(language, "活跃会话", "Active sessions")}
          </span>
          <span>
            <b>{testingTotals?.totalTestSessions ?? 0}</b>
            {localized(language, "会话总数", "Total sessions")}
          </span>
          <span>
            <b>{formatBytes(testingTotals?.audioUpBytes ?? 0)}</b>
            {localized(language, "麦克风上行", "Mic uplink")}
          </span>
          <span>
            <b>{formatBytes(totalDownBytes)}</b>
            {localized(language, "下行", "Downlink")}
          </span>
          <span>
            <b>{latencyLabel(timelineLatencySamples, testingTotals?.avgLatencyMs ?? 0)}</b>
            {localized(language, "平均首音", "Average first audio")}
          </span>
          <span>
            <b>{latencyLabel(timelineLatencySamples, testingTotals?.p95LatencyMs ?? 0)}</b>
            P95 {localized(language, "首音", "first audio")}
          </span>
          <span>
            <b>{testingTotals?.errorEvents ?? 0}</b>
            {localized(language, "错误", "Errors")}
          </span>
          <span>
            <b>{testingTotals?.ttsFallbacks ?? 0}</b>
            {localized(language, "TTS 回退", "TTS fallback")}
          </span>
        </div>
        <div className="chartGrid">
          <div className="chartBlock">
            <div className="instrumentHead">
              <span>{localized(language, "带宽", "Bandwidth")}</span>
              <b>{formatBytes(totalBandwidthBytes)}</b>
            </div>
            <div className="miniChart" aria-label={localized(language, "最近带宽趋势", "Recent bandwidth trend")}>
              {testingTimeline.map((bucket) => {
                const bytes = bucket.audioUpBytes + bucket.audioDownBytes + bucket.controlDownBytes;
                return (
                  <i
                    key={bucket.at}
                    style={{ height: barHeight(bytes, maxBandwidthBucket) }}
                    title={`${formatClockTime(bucket.at)} · ${formatBytes(bytes)}`}
                  />
                );
              })}
            </div>
            <div className="chartLegend">
              <span>
                {localized(language, "上行", "Uplink")} {formatBytes(testingTotals?.audioUpBytes ?? 0)}
              </span>
              <span>
                {localized(language, "下行", "Downlink")} {formatBytes(totalDownBytes)}
              </span>
            </div>
          </div>
          <div className="chartBlock">
            <div className="instrumentHead">
              <span>{localized(language, "首音延迟", "First audio latency")}</span>
              <b>
                {timelineLatencySamples > 0 ? `${testingTotals?.p95LatencyMs ?? 0}ms P95` : "—"}{" "}
                {timelineLatencySamples === 0 ? localized(language, "无样本", "no samples") : ""}
              </b>
            </div>
            <div
              className="miniChart latencyChart"
              aria-label={localized(language, "最近首音延迟趋势", "Recent first-audio latency trend")}
            >
              {testingTimeline.map((bucket) => (
                <i
                  key={bucket.at}
                  style={{ height: barHeight(bucket.avgLatencyMs, maxLatencyBucket) }}
                  title={`${formatClockTime(bucket.at)} · ${latencyLabel(bucket.latencySamples, bucket.avgLatencyMs)}`}
                />
              ))}
            </div>
            <div className="chartLegend">
              <span>
                {timelineLatencySamples} {localized(language, "个样本", "samples")}
              </span>
              <span>
                {testingTotals?.errorEvents ?? 0} {localized(language, "个错误", "errors")}
              </span>
            </div>
          </div>
        </div>
        <div className="testerTableWrap">
          <div className="testerTableFilter">
            <label>
              <span>{localized(language, "查找测试员", "Find tester")}</span>
              <input
                value={testerFilter}
                onChange={(event) => {
                  setArmedAction(null);
                  setTesterFilter(event.target.value);
                }}
                placeholder={localized(language, "ID、IP 或区域", "ID, IP, or region")}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          </div>
          <table className="testerTable">
            <thead>
              <tr>
                <th>{localized(language, "测试员", "Tester")}</th>
                <th>IP / {localized(language, "区域", "Region")}</th>
                <th>{localized(language, "会话", "Sessions")}</th>
                <th>{localized(language, "质量", "Quality")}</th>
                <th>{localized(language, "问题", "Issues")}</th>
                <th>{localized(language, "时长", "Duration")}</th>
                <th>{localized(language, "数据量", "Data")}</th>
                <th>{localized(language, "延迟", "Latency")}</th>
                <th>{localized(language, "最近活动", "Last activity")}</th>
              </tr>
            </thead>
            <tbody>
              {filteredTesterUsers.length ? (
                filteredTesterUsers.map((tester) => {
                  const counts = tester.qualityCounts;
                  const testerIssues = counts.fail + counts.watch + tester.errorEvents;
                  return (
                    <tr
                      className={selectedTester?.testerKey === tester.testerKey ? "selected" : ""}
                      key={tester.testerKey}
                    >
                      <td>
                        <button className="testerLink" type="button" onClick={() => setFilterTester(tester.testerId)}>
                          <strong>{tester.testerId}</strong>
                          <span>
                            {tester.activeSessions
                              ? localized(language, "活跃", "Active")
                              : `${tester.errorEvents} ${localized(language, "个错误", "errors")}`}
                          </span>
                        </button>
                      </td>
                      <td>
                        <button className="testerLink" type="button" onClick={() => setFilterTester(tester.testerId)}>
                          <strong>{tester.ipAddress}</strong>
                          <span>{tester.region}</span>
                        </button>
                      </td>
                      <td>{tester.totalSessions}</td>
                      <td>
                        <span className="qualityBreakdown">{qualityBreakdownLabel(counts)}</span>
                      </td>
                      <td>
                        <span className={testerIssues ? "issueCount active" : "issueCount"}>{testerIssues}</span>
                      </td>
                      <td>{formatDuration(tester.totalSessionMs)}</td>
                      <td>{formatBytes(tester.audioUpBytes + tester.audioDownBytes + tester.controlDownBytes)}</td>
                      <td>
                        {latencyLabel(tester.latencySamples, tester.avgLatencyMs)}/
                        {latencyLabel(tester.latencySamples, tester.p95LatencyMs)}
                      </td>
                      <td>{formatAdminRelativeTime(tester.lastSeenAt, language)}</td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={9}>
                    {testerUsers.length
                      ? localized(language, "没有匹配筛选条件的测试员", "No testers match the current filters")
                      : localized(language, "暂无测试会话", "No test sessions")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="testerConversationPanel">
          <div className="testerConversationHeader">
            <div>
              <span>{localized(language, "测试员最近对话", "Tester's recent conversation")}</span>
              <strong>{selectedTester?.testerId ?? localized(language, "全部测试员", "All testers")}</strong>
              {selectedTester ? (
                <p>
                  {selectedTester.ipAddress} · {selectedTester.region} · {selectedTester.totalSessions}{" "}
                  {localized(language, "次会话", "sessions")} · {qualityBreakdownLabel(selectedTesterCounts)} ·{" "}
                  {formatAdminRelativeTime(selectedTester.lastSeenAt, language)}
                </p>
              ) : null}
            </div>
            <div className="testerConversationActions">
              <button
                type="button"
                className={`danger adminDanger ${armedAction === `clear-tester:${selectedTester?.testerKey}` ? "armed" : ""}`}
                disabled={busyAction !== null || !selectedTester || !canClear}
                title={
                  canClear ? undefined : localized(language, "需要管理员权限", "Administrator permission required")
                }
                onClick={() => {
                  if (!selectedTester) return;
                  const key = `clear-tester:${selectedTester.testerKey}`;
                  arm(
                    key,
                    () =>
                      void runClear(
                        key,
                        { scope: "tester", testerKey: selectedTester.testerKey },
                        localized(
                          language,
                          `测试员 ${selectedTester.testerId} 的全部证据`,
                          `all evidence for tester ${selectedTester.testerId}`
                        ),
                        testerClearIds
                      )
                  );
                }}
              >
                {armedAction === `clear-tester:${selectedTester?.testerKey}` && selectedTester
                  ? confirmationCopy("tester", selectedTester.testerId, language)
                  : localized(language, "清除此测试员证据", "Clear this tester's evidence")}
              </button>
            </div>
          </div>
          <div className="testerConversationList">
            {selectedTesterTurns.length ? (
              selectedTesterTurns.map((turn, index) => (
                <article
                  className={`testerTurn ${turn.speaker}`}
                  key={`${turn.sessionId}-${turn.at}-${turn.speaker}-${index}`}
                >
                  <div>
                    <strong>{turn.speaker === "rider" ? localized(language, "骑手", "Rider") : "Max"}</strong>
                    <span>
                      {formatClockTime(turn.at)} ·{" "}
                      {turn.final ? localized(language, "最终", "Final") : localized(language, "实时", "Live")}
                    </span>
                    {turn.feedback ? <span className="turnFlagChip">⚑ {turn.feedback}</span> : null}
                  </div>
                  <p>{turn.text}</p>
                </article>
              ))
            ) : (
              <p className="testerConversationEmpty">
                {selectedTester
                  ? localized(language, "尚未捕获对话转写。", "No conversation transcript captured yet.")
                  : localized(
                      language,
                      "在上方表格选择测试员，查看其最近对话。",
                      "Pick a tester in the table above to see their recent conversation."
                    )}
              </p>
            )}
          </div>
        </div>
      </details>

      <details className="adminCollapsible evidenceExecution">
        <summary>{localized(language, "测试执行设置", "Test execution setup")}</summary>
        <div className="testerBar">
          <label>
            <span>{localized(language, "测试员 ID", "Tester ID")}</span>
            <input
              value={agent.testerId}
              onChange={(event) => agent.setTesterId(event.target.value)}
              placeholder="tester-name"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <div className={`testQuality ${qualityTone}`}>
            <span>{localized(language, "质量", "Quality")}</span>
            <strong>
              {qualityTone === "none"
                ? localized(language, "无数据", "NO DATA")
                : qualityTone === "collecting"
                  ? localized(language, "采集中", "COLLECTING")
                  : qualityTone === "invalid"
                    ? localized(language, "无效证据", "INVALID EVIDENCE")
                    : qualityTone === "good"
                      ? "PASS"
                      : qualityTone === "warn"
                        ? "WATCH"
                        : "FAIL"}
            </strong>
          </div>
          <div>
            <span>{localized(language, "当前测试员", "Current tester")}</span>
            <strong>
              {currentTester
                ? `${currentTester.totalSessions} ${localized(language, "次会话", "sessions")}`
                : localized(language, "新测试员", "New tester")}
            </strong>
          </div>
          <div>
            <span>IP / {localized(language, "区域", "Region")}</span>
            <strong>
              {currentTester
                ? `${currentTester.ipAddress} · ${currentTester.region}`
                : `${localized(language, "待采集", "Pending")} · ${agent.testerRegion}`}
            </strong>
          </div>
        </div>
        <div className="testingWorkflowBar">
          <label>
            <span>{localized(language, "测试活动", "Test campaign")}</span>
            <select
              value={selectedCampaign.id}
              onChange={(event) => {
                setArmedAction(null);
                agent.setTestingCampaignId(event.target.value);
              }}
            >
              {testingCampaigns.map((campaign) => (
                <option key={campaign.id} value={campaign.id}>
                  {campaign.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{localized(language, "测试用例", "Test case")}</span>
            <select
              value={selectedTestCase.id}
              onChange={(event) => {
                setArmedAction(null);
                agent.setTestingTestCaseId(event.target.value);
              }}
            >
              {testCasesForCampaign.map((testCase) => (
                <option key={testCase.id} value={testCase.id}>
                  {testCase.name}
                </option>
              ))}
            </select>
          </label>
          <div className="testCaseBrief">
            <span>{selectedTestCase.id}</span>
            <strong>{selectedTestCase.description}</strong>
            <p>
              {scenarioLabel(selectedTestCase.scenario)} · {selectedTestCase.rideMode} · P95 ≤{" "}
              {selectedTestCase.maxP95LatencyMs}ms
            </p>
            <div className="testRequirementChips">
              {selectedTestRequirements.map((requirement) => (
                <span key={requirement}>{requirement}</span>
              ))}
            </div>
          </div>
        </div>
      </details>
    </section>
  );
}
