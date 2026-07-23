import { useCallback, useEffect, useRef, useState } from "react";
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
import type { AuthUser } from "../../lib/auth";
import {
  exportTestingReport,
  exportTestingSession,
  formatBytes,
  formatClockTime,
  formatDuration,
  formatRelativeTime,
  type TestingClearScope
} from "../../lib/utils";
import { confirmationCopy, corpusIssueCount } from "./admin-model";
import type { AdminTestingData } from "./useAdminTestingData";

const TEST_QUALITY_FILTERS = ["all", "pass", "watch", "fail"] as const;
type TestQualityFilter = (typeof TEST_QUALITY_FILTERS)[number];
type QualityCounts = Record<TestingQuality, number>;
type PendingNoteSave = {
  requestId: number;
  sessionId: string;
  notes: string;
};
type Notice = { tone: "success" | "error"; message: string };
type ReviewBusyTarget = { kind: "composer" } | { kind: "status"; id: string } | null;

const QUALITY_PRIORITY: Record<TestingQuality, number> = { fail: 3, watch: 2, pass: 1 };
const REVIEW_STATUSES: TestingReviewStatus[] = ["open", "triaged", "resolved", "waived"];
const REVIEW_SEVERITIES: TestingReviewSeverity[] = ["low", "medium", "high", "critical"];

function testQualityLabel(quality: TestQualityFilter) {
  if (quality === "all") return "全部";
  if (quality === "pass") return "PASS";
  if (quality === "watch") return "WATCH";
  return "FAIL";
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

function testRequirementLabels(testCase: TestingTestCase) {
  return [
    testCase.requireWakeWord ? "唤醒词" : null,
    testCase.requireMicAudio ? "麦克风音频" : null,
    testCase.requireTranscript ? "转写" : null,
    testCase.requireEmergencyResponse ? "紧急响应" : null,
    testCase.requireAdasAlert ? "ADAS 警报" : null,
    testCase.forbidUnsafeAdvice ? "禁止不安全建议" : null
  ].filter((requirement): requirement is string => Boolean(requirement));
}

function formatSessionDate(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", {
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
  const [selectedTesterKey, setSelectedTesterKey] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [testerFilter, setTesterFilter] = useState("");
  const [sessionFilter, setSessionFilter] = useState("");
  const [qualityFilter, setQualityFilter] = useState<TestQualityFilter>("all");
  const [armedAction, setArmedAction] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pendingNoteSave, setPendingNoteSave] = useState<PendingNoteSave | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [reviewBusyTarget, setReviewBusyTarget] = useState<ReviewBusyTarget>(null);
  const [reviewTitle, setReviewTitle] = useState("会话需要复核");
  const [reviewComment, setReviewComment] = useState("");
  const [reviewSeverity, setReviewSeverity] = useState<TestingReviewSeverity>("medium");
  const [reviewOwner, setReviewOwner] = useState(user.username);
  const [sessionNotes, setSessionNotes] = useState("");
  const [notesDirty, setNotesDirty] = useState(false);
  const notesDirtyRef = useRef(false);
  const noteSessionIdRef = useRef<string | null>(null);
  const sessionNotesRef = useRef("");
  const noteSaveRequestRef = useRef(0);
  const workspaceRef = useRef<HTMLElement>(null);
  const handledFocusRequestRef = useRef(0);
  const reviewDraftKeyRef = useRef("");
  const writeSessionNotes = useCallback((notes: string) => {
    sessionNotesRef.current = notes;
    setSessionNotes(notes);
  }, []);

  const { loadSession } = data;
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
  const selectedTester = selectedTesterKey
    ? testerUsers.find((tester) => tester.testerKey === selectedTesterKey)
    : (currentTester ?? testerUsers[0]);
  const selectedTesterTurns = selectedTester?.recentTurns ?? [];
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
  const selectedTesterSessions = selectedTesterKey
    ? testingSessions.filter((session) => session.testerKey === selectedTesterKey)
    : selectedTester
      ? testingSessions.filter((session) => session.testerKey === selectedTester.testerKey)
      : testingSessions;
  const normalizedSessionFilter = sessionFilter.trim().toLowerCase();
  const filteredTestingSessions = [...selectedTesterSessions]
    .sort(
      (a, b) =>
        QUALITY_PRIORITY[b.quality] - QUALITY_PRIORITY[a.quality] ||
        sessionIssueCount(b) - sessionIssueCount(a) ||
        b.endedAt - a.endedAt
    )
    .filter((session) => qualityFilter === "all" || session.quality === qualityFilter)
    .filter((session) => {
      if (!normalizedSessionFilter) return true;
      const searchable = [
        session.sessionId,
        session.campaignName,
        session.testCaseName,
        session.deviceLabel,
        session.networkType,
        session.browserLanguage,
        session.appVersion,
        session.gitCommit,
        session.notes,
        session.validity.detail,
        ...session.validity.reasons,
        ...session.flags,
        ...session.evaluation.checks.map((check) => `${check.label} ${check.status} ${check.detail}`)
      ];
      return searchable.join(" ").toLowerCase().includes(normalizedSessionFilter);
    });
  const initialFilteredSession = filteredTestingSessions[0];
  const initialFilteredSessionId = initialFilteredSession?.sessionId;
  const initialFilteredTesterKey = initialFilteredSession?.testerKey;
  const selectedSessionSummary = selectedSessionId
    ? testingSessions.find((session) => session.sessionId === selectedSessionId)
    : undefined;
  const selectedSession = selectedSessionId ? (sessionDetails[selectedSessionId] ?? selectedSessionSummary) : undefined;
  const selectedReview = selectedSession
    ? (data.operations?.reviews ?? []).find(
        (review) =>
          review.sessionId === selectedSession.sessionId && (review.status === "open" || review.status === "triaged")
      )
    : undefined;
  const requestedSessionSummary = requestedSessionId
    ? testingSessions.find((session) => session.sessionId === requestedSessionId)
    : undefined;
  const selectedSessionTurns = selectedSession?.turns ?? [];
  const selectedTesterCounts = selectedTester?.qualityCounts ?? emptyQualityCounts();
  const selectedSessionIssues = selectedSession ? sessionIssueCount(selectedSession) : 0;
  const selectedTestRequirements = testRequirementLabels(selectedTestCase);
  const totalDownBytes = (testingTotals?.audioDownBytes ?? 0) + (testingTotals?.controlDownBytes ?? 0);
  const totalBandwidthBytes = (testingTotals?.audioUpBytes ?? 0) + totalDownBytes;
  const maxBandwidthBucket = Math.max(
    1,
    ...testingTimeline.map((bucket) => bucket.audioUpBytes + bucket.audioDownBytes + bucket.controlDownBytes)
  );
  const maxLatencyBucket = Math.max(1, ...testingTimeline.map((bucket) => bucket.avgLatencyMs));
  const qualityTone =
    (testingTotals?.errorEvents ?? 0) > 0 || (testingTotals?.p95LatencyMs ?? 0) > 800
      ? "alert"
      : (testingTotals?.p95LatencyMs ?? 0) > 320 || (testingTotals?.ttsFallbacks ?? 0) > 0
        ? "warn"
        : "good";
  const canClear = user.role === "admin";
  const currentDraftIsSaving =
    pendingNoteSave !== null &&
    pendingNoteSave.sessionId === selectedSession?.sessionId &&
    pendingNoteSave.notes === sessionNotes;

  useEffect(() => {
    if (!armedAction) return;
    const timer = window.setTimeout(() => setArmedAction(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [armedAction]);

  useEffect(() => {
    setArmedAction(null);
  }, [selectedSession?.sessionId, selectedTester?.testerKey]);

  useEffect(() => {
    if (!active || requestedSessionId || selectedSessionId || !initialFilteredSessionId || !initialFilteredTesterKey) {
      return;
    }
    notesDirtyRef.current = false;
    noteSessionIdRef.current = null;
    setNotesDirty(false);
    setSelectedTesterKey(initialFilteredTesterKey);
    setSelectedSessionId(initialFilteredSessionId);
  }, [active, initialFilteredSessionId, initialFilteredTesterKey, requestedSessionId, selectedSessionId]);

  useEffect(() => {
    const sessionId = selectedSession?.sessionId;
    if (!active || requestedSessionId || !sessionId) return;
    void loadSession(sessionId);
  }, [active, loadSession, requestedSessionId, selectedSession?.sessionId]);

  useEffect(() => {
    const sessionId = selectedSession?.sessionId ?? null;
    if (noteSessionIdRef.current === sessionId && notesDirtyRef.current) return;
    noteSessionIdRef.current = sessionId;
    notesDirtyRef.current = false;
    setNotesDirty(false);
    writeSessionNotes(selectedSession?.notes ?? "");
  }, [selectedSession?.notes, selectedSession?.sessionId, writeSessionNotes]);

  useEffect(() => {
    const sessionId = selectedSession?.sessionId;
    if (!sessionId) return;
    const key = `${sessionId}:${selectedReview?.id ?? "new"}`;
    if (reviewDraftKeyRef.current === key) return;
    reviewDraftKeyRef.current = key;
    setReviewTitle(selectedReview?.title ?? "会话需要复核");
    setReviewComment(selectedReview?.comment ?? "");
    setReviewSeverity(selectedReview?.severity ?? "medium");
    setReviewOwner(selectedReview?.owner ?? user.username);
  }, [selectedReview, selectedSession?.sessionId, user.username]);

  useEffect(() => {
    if (!active || !requestedSessionId) return;
    let current = true;
    setArmedAction(null);
    setTesterFilter("");
    setSessionFilter("");
    setQualityFilter(requestedSessionSummary?.quality ?? "all");
    setSelectedTesterKey(requestedSessionSummary?.testerKey ?? null);
    setSelectedSessionId(requestedSessionId);
    noteSessionIdRef.current = requestedSessionId;
    notesDirtyRef.current = false;
    setNotesDirty(false);
    writeSessionNotes(requestedSessionSummary?.notes ?? "");
    void loadSession(requestedSessionId).then((detail) => {
      if (!current) return;
      if (detail) {
        setQualityFilter(detail.quality);
        setSelectedTesterKey(detail.testerKey);
        setSelectedSessionId(detail.sessionId);
        noteSessionIdRef.current = detail.sessionId;
        notesDirtyRef.current = false;
        setNotesDirty(false);
        writeSessionNotes(detail.notes);
        setNotice(null);
      } else {
        setNotice({ tone: "error", message: "所选证据不可用，或已超出当前账号的访问范围。" });
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
    focusRequestKey,
    loadSession,
    onRequestedSessionHandled,
    requestedSessionId,
    requestedSessionSummary?.notes,
    requestedSessionSummary?.quality,
    requestedSessionSummary?.testerKey,
    writeSessionNotes
  ]);

  useEffect(() => {
    if (!active || requestedSessionId || focusRequestKey === 0 || handledFocusRequestRef.current === focusRequestKey) {
      return;
    }
    handledFocusRequestRef.current = focusRequestKey;
    workspaceRef.current?.focus();
  }, [active, focusRequestKey, requestedSessionId]);

  const arm = (key: string, action: () => void) => {
    if (armedAction === key) {
      setArmedAction(null);
      action();
    } else {
      setArmedAction(key);
    }
  };

  const selectTester = (testerKey: string) => {
    setArmedAction(null);
    noteSessionIdRef.current = null;
    notesDirtyRef.current = false;
    setNotesDirty(false);
    writeSessionNotes("");
    setSelectedTesterKey(testerKey);
    setSelectedSessionId(null);
  };

  const selectSession = (sessionId: string) => {
    const session = sessionDetails[sessionId] ?? testingSessions.find((item) => item.sessionId === sessionId);
    setArmedAction(null);
    noteSessionIdRef.current = sessionId;
    notesDirtyRef.current = false;
    setNotesDirty(false);
    writeSessionNotes(session?.notes ?? "");
    setSelectedSessionId(sessionId);
  };

  const selectReviewEvidence = async (sessionId: string) => {
    const session = sessionDetails[sessionId] ?? testingSessions.find((item) => item.sessionId === sessionId);
    setTesterFilter("");
    setSessionFilter("");
    setQualityFilter(session?.quality ?? "all");
    setSelectedTesterKey(session?.testerKey ?? null);
    selectSession(sessionId);
    if (session) return;
    const detail = await data.loadSession(sessionId);
    if (!detail) {
      setNotice({ tone: "error", message: "复核记录关联的证据不可用，或已超出当前账号的访问范围。" });
      return;
    }
    setQualityFilter(detail.quality);
    setSelectedTesterKey(detail.testerKey);
    noteSessionIdRef.current = detail.sessionId;
    writeSessionNotes(detail.notes);
  };

  const runClear = async (key: string, payload: TestingClearScope, targetLabel: string) => {
    setBusyAction(key);
    setNotice(null);
    const ok = await data.clearEvidence(payload);
    if (ok) {
      noteSessionIdRef.current = null;
      notesDirtyRef.current = false;
      setNotesDirty(false);
      setSelectedSessionId(null);
      writeSessionNotes("");
      if (payload.scope !== "session") setSelectedTesterKey(null);
      await agent.refreshHealth();
      setNotice({ tone: "success", message: `已清除 ${targetLabel}。` });
    } else {
      setNotice({ tone: "error", message: `清除 ${targetLabel} 失败。需要管理员权限，并请确认中继在线。` });
    }
    setBusyAction(null);
  };

  const loadMoreEvidence = async () => {
    setLoadingMore(true);
    await data.loadMore();
    setLoadingMore(false);
  };

  const saveSessionNotes = async () => {
    if (!selectedSession) return;
    const submittedSessionId = selectedSession.sessionId;
    const submittedNotes = sessionNotesRef.current;
    const requestId = ++noteSaveRequestRef.current;
    setPendingNoteSave({ requestId, sessionId: submittedSessionId, notes: submittedNotes });
    setNotice(null);
    const ok = await data.saveNotes(submittedSessionId, submittedNotes);
    const ownsCurrentDraft =
      noteSessionIdRef.current === submittedSessionId && sessionNotesRef.current === submittedNotes;
    if (ok && ownsCurrentDraft) {
      notesDirtyRef.current = false;
      setNotesDirty(false);
    }
    if (requestId === noteSaveRequestRef.current && noteSessionIdRef.current === submittedSessionId) {
      setNotice({
        tone: ok ? "success" : "error",
        message: ok ? "证据备注已保存并写入审计记录。" : "证据备注保存失败；请确认审核员权限和中继状态。"
      });
    }
    setPendingNoteSave((current) => (current?.requestId === requestId ? null : current));
  };

  const saveReview = async (input: Partial<TestingReview> & { sessionId: string }, target: ReviewBusyTarget) => {
    setReviewBusyTarget(target);
    setNotice(null);
    const result = await data.saveReview(input);
    if (result.ok) {
      setNotice({ tone: "success", message: "复核记录已保存并写入审计日志。" });
      await data.refresh();
    } else {
      setNotice({ tone: "error", message: result.error.message });
    }
    setReviewBusyTarget(null);
  };

  const submitReview = async () => {
    if (!selectedSession) return;
    await saveReview(
      {
        id: selectedReview?.id,
        sessionId: selectedSession.sessionId,
        runId: selectedSession.runId,
        status: selectedReview?.status ?? "open",
        severity: reviewSeverity,
        owner: reviewOwner.trim() || user.username,
        title: reviewTitle.trim() || "会话需要复核",
        comment: reviewComment.trim()
      },
      { kind: "composer" }
    );
  };

  const changeReviewStatus = async (review: TestingReview, status: TestingReviewStatus) => {
    await saveReview(
      {
        ...review,
        status,
        resolution: status === "resolved" ? "已复核" : review.resolution
      },
      { kind: "status", id: review.id }
    );
  };

  if (!testing) {
    return (
      <section
        ref={workspaceRef}
        className="hudPanel testingPanel"
        aria-label="证据与问题"
        aria-busy={data.status === "loading"}
        hidden={!active}
        inert={!active ? true : undefined}
        tabIndex={-1}
      >
        <p className="adminWorkspaceLoading">
          {data.status === "loading" ? "正在加载证据与问题…" : "暂无可用证据数据。"}
        </p>
      </section>
    );
  }

  return (
    <section
      ref={workspaceRef}
      className="hudPanel testingPanel"
      aria-label="证据与问题"
      hidden={!active}
      inert={!active ? true : undefined}
      tabIndex={-1}
    >
      <div className="panelHeader">
        <div>
          <h2>证据与问题</h2>
          <span>
            {testing ? `${testing.windowMinutes} 分钟 · ${testing.users.length} 位测试员` : "等待证据"}
            {agent.health?.build ? ` · 构建 ${agent.health.build.gitCommit}` : ""}
          </span>
        </div>
        <div className="panelActions">
          <span>{corpusIssueCount(testerUsers)} 项待复核</span>
          <button
            type="button"
            onClick={() => exportTestingReport(agent.health, agent.testerId, agent.testerRegion, testing)}
          >
            导出统计
          </button>
          <button
            type="button"
            className={`danger ${armedAction === "clear-all" ? "armed" : ""}`}
            disabled={busyAction !== null || !testerUsers.length || !canClear}
            title={canClear ? undefined : "需要管理员权限"}
            onClick={() => arm("clear-all", () => void runClear("clear-all", { scope: "all" }, "全部测试证据"))}
          >
            {armedAction === "clear-all" ? confirmationCopy("all-evidence", "全部测试证据") : "清除全部证据"}
          </button>
        </div>
      </div>

      {notice ? (
        <p className={`adminNotice ${notice.tone}`} role="status">
          {notice.message}
        </p>
      ) : null}

      <div className="testerBar">
        <label>
          <span>测试员 ID</span>
          <input
            value={agent.testerId}
            onChange={(event) => agent.setTesterId(event.target.value)}
            placeholder="tester-name"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <div className={`testQuality ${qualityTone}`}>
          <span>质量</span>
          <strong>{qualityTone === "good" ? "PASS" : qualityTone === "warn" ? "WATCH" : "FAIL"}</strong>
        </div>
        <div>
          <span>当前测试员</span>
          <strong>{currentTester ? `${currentTester.totalSessions} 次会话` : "新测试员"}</strong>
        </div>
        <div>
          <span>IP / 区域</span>
          <strong>
            {currentTester ? `${currentTester.ipAddress} · ${currentTester.region}` : `待采集 · ${agent.testerRegion}`}
          </strong>
        </div>
      </div>

      <div className="testingWorkflowBar">
        <label>
          <span>测试活动</span>
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
          <span>测试用例</span>
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

      <div className="testingFilterBar">
        <label>
          <span>查找测试员</span>
          <input
            value={testerFilter}
            onChange={(event) => {
              setArmedAction(null);
              setTesterFilter(event.target.value);
            }}
            placeholder="ID、IP 或区域"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label>
          <span>查找会话</span>
          <input
            value={sessionFilter}
            onChange={(event) => {
              setArmedAction(null);
              noteSessionIdRef.current = null;
              notesDirtyRef.current = false;
              setNotesDirty(false);
              writeSessionNotes("");
              setSessionFilter(event.target.value);
              setSelectedSessionId(null);
            }}
            placeholder="用例、设备、标记或构建"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <div className="qualityFilter" role="group" aria-label="会话质量筛选">
          {TEST_QUALITY_FILTERS.map((quality) => (
            <button
              key={quality}
              type="button"
              className={qualityFilter === quality ? "active" : ""}
              aria-pressed={qualityFilter === quality}
              onClick={() => {
                setArmedAction(null);
                noteSessionIdRef.current = null;
                notesDirtyRef.current = false;
                setNotesDirty(false);
                writeSessionNotes("");
                setQualityFilter(quality);
                setSelectedSessionId(null);
              }}
            >
              {testQualityLabel(quality)}
            </button>
          ))}
        </div>
        <div className="historyRetention">
          <span>证据历史</span>
          <strong>
            {testing?.history.persistent ? "持久化" : "内存"} · 已加载 {testingSessions.length}/{data.sessionTotal}
          </strong>
        </div>
      </div>

      <div className="statGrid">
        <span>
          <b>{testingTotals?.activeTestSessions ?? agent.health?.metrics?.activeSessions ?? 0}</b>
          活跃会话
        </span>
        <span>
          <b>{testingTotals?.totalTestSessions ?? 0}</b>
          会话总数
        </span>
        <span>
          <b>{formatBytes(testingTotals?.audioUpBytes ?? 0)}</b>
          麦克风上行
        </span>
        <span>
          <b>{formatBytes(totalDownBytes)}</b>
          下行
        </span>
        <span>
          <b>{testingTotals?.avgLatencyMs ?? 0}ms</b>
          平均首音
        </span>
        <span>
          <b>{testingTotals?.p95LatencyMs ?? 0}ms</b>
          P95 首音
        </span>
        <span>
          <b>{testingTotals?.errorEvents ?? 0}</b>
          错误
        </span>
        <span>
          <b>{testingTotals?.ttsFallbacks ?? 0}</b>
          TTS 回退
        </span>
      </div>

      <div className="chartGrid">
        <div className="chartBlock">
          <div className="instrumentHead">
            <span>带宽</span>
            <b>{formatBytes(totalBandwidthBytes)}</b>
          </div>
          <div className="miniChart" aria-label="最近带宽趋势">
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
            <span>上行 {formatBytes(testingTotals?.audioUpBytes ?? 0)}</span>
            <span>下行 {formatBytes(totalDownBytes)}</span>
          </div>
        </div>
        <div className="chartBlock">
          <div className="instrumentHead">
            <span>首音延迟</span>
            <b>{testingTotals?.p95LatencyMs ?? 0}ms P95</b>
          </div>
          <div className="miniChart latencyChart" aria-label="最近首音延迟趋势">
            {testingTimeline.map((bucket) => (
              <i
                key={bucket.at}
                style={{ height: barHeight(bucket.avgLatencyMs, maxLatencyBucket) }}
                title={`${formatClockTime(bucket.at)} · ${bucket.avgLatencyMs}ms`}
              />
            ))}
          </div>
          <div className="chartLegend">
            <span>{testingTimeline.reduce((sum, bucket) => sum + bucket.latencySamples, 0)} 个样本</span>
            <span>{testingTotals?.errorEvents ?? 0} 个错误</span>
          </div>
        </div>
      </div>

      <div className="testerTableWrap">
        <table className="testerTable">
          <thead>
            <tr>
              <th>测试员</th>
              <th>IP / 区域</th>
              <th>会话</th>
              <th>质量</th>
              <th>问题</th>
              <th>时长</th>
              <th>数据量</th>
              <th>延迟</th>
              <th>最近活动</th>
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
                      <button className="testerLink" type="button" onClick={() => selectTester(tester.testerKey)}>
                        <strong>{tester.testerId}</strong>
                        <span>{tester.activeSessions ? "活跃" : `${tester.errorEvents} 个错误`}</span>
                      </button>
                    </td>
                    <td>
                      <button className="testerLink" type="button" onClick={() => selectTester(tester.testerKey)}>
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
                      {tester.avgLatencyMs}/{tester.p95LatencyMs}ms
                    </td>
                    <td>{formatRelativeTime(tester.lastSeenAt)}</td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={9}>{testerUsers.length ? "没有匹配筛选条件的测试员" : "暂无测试会话"}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="testerConversationPanel">
        <div className="testerConversationHeader">
          <div>
            <span>对话历史</span>
            <strong>{selectedTester?.testerId ?? "未选择测试员"}</strong>
            {selectedTester ? (
              <p>
                {selectedTester.ipAddress} · {selectedTester.region} · {selectedTester.totalSessions} 次会话 ·{" "}
                {qualityBreakdownLabel(selectedTesterCounts)} · {formatRelativeTime(selectedTester.lastSeenAt)}
              </p>
            ) : null}
          </div>
          <div className="testerConversationActions">
            <button
              type="button"
              onClick={() => {
                setArmedAction(null);
                noteSessionIdRef.current = null;
                notesDirtyRef.current = false;
                setNotesDirty(false);
                writeSessionNotes("");
                setSelectedTesterKey(currentTester?.testerKey ?? null);
                setSelectedSessionId(null);
              }}
              disabled={!currentTester}
            >
              当前测试员
            </button>
            <button
              type="button"
              className={`danger ${armedAction === `clear-tester:${selectedTester?.testerKey}` ? "armed" : ""}`}
              disabled={busyAction !== null || !selectedTester || !canClear}
              title={canClear ? undefined : "需要管理员权限"}
              onClick={() => {
                if (!selectedTester) return;
                const key = `clear-tester:${selectedTester.testerKey}`;
                arm(
                  key,
                  () =>
                    void runClear(
                      key,
                      { scope: "tester", testerKey: selectedTester.testerKey },
                      `测试员 ${selectedTester.testerId} 的全部证据`
                    )
                );
              }}
            >
              {armedAction === `clear-tester:${selectedTester?.testerKey}` && selectedTester
                ? confirmationCopy("tester", selectedTester.testerId)
                : "清除此测试员证据"}
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
                  <strong>{turn.speaker === "rider" ? "骑手" : "Max"}</strong>
                  <span>
                    {formatClockTime(turn.at)} · {turn.final ? "最终" : "实时"}
                  </span>
                  {turn.feedback ? <span className="turnFlagChip">⚑ {turn.feedback}</span> : null}
                </div>
                <p>{turn.text}</p>
              </article>
            ))
          ) : (
            <p className="testerConversationEmpty">尚未捕获对话转写。</p>
          )}
        </div>
      </div>

      <div className="testerSessionPanel">
        <div className="testerConversationHeader">
          <div>
            <span>会话回放</span>
            <strong>{selectedSession ? formatSessionDate(selectedSession.startedAt) : "暂无已完成会话"}</strong>
            {selectedSession ? (
              <p>
                {selectedSession.campaignName} · {selectedSession.testCaseName} ·{" "}
                {formatDuration(selectedSession.durationMs)} · {selectedSessionIssues} 个问题
              </p>
            ) : null}
          </div>
          <div className="testerConversationActions">
            <button
              type="button"
              onClick={() => selectedSession && exportTestingSession(selectedSession)}
              disabled={!selectedSession}
            >
              导出会话
            </button>
            <button
              type="button"
              className={`danger ${armedAction === `clear-session:${selectedSession?.sessionId}` ? "armed" : ""}`}
              disabled={busyAction !== null || !selectedSession || !canClear}
              title={canClear ? undefined : "需要管理员权限"}
              onClick={() => {
                if (!selectedSession) return;
                const key = `clear-session:${selectedSession.sessionId}`;
                arm(
                  key,
                  () =>
                    void runClear(
                      key,
                      { scope: "session", sessionId: selectedSession.sessionId },
                      `会话 ${selectedSession.sessionId}`
                    )
                );
              }}
            >
              {armedAction === `clear-session:${selectedSession?.sessionId}` && selectedSession
                ? confirmationCopy("session", selectedSession.sessionId)
                : "删除会话"}
            </button>
          </div>
        </div>
        <div className="sessionReplayGrid">
          <div className="sessionList" aria-label="已完成测试会话">
            {filteredTestingSessions.length ? (
              filteredTestingSessions.map((session) => {
                const issues = sessionIssueCount(session);
                return (
                  <button
                    className={`sessionButton ${selectedSession?.sessionId === session.sessionId ? "active" : ""}`}
                    key={session.sessionId}
                    type="button"
                    onClick={() => selectSession(session.sessionId)}
                  >
                    <span className={`sessionQuality ${testQualityClass(session.quality)}`}>
                      {testQualityLabel(session.quality)}
                    </span>
                    <strong>{formatSessionDate(session.startedAt)}</strong>
                    <span>{session.testCaseName}</span>
                    <span>
                      {formatDuration(session.durationMs)} · {session.platform} · {session.p95LatencyMs}ms P95
                    </span>
                    <span>
                      评分 {session.evaluation.score} · {issues} 个问题
                    </span>
                    <span>{session.validity.status === "valid" ? "有效证据" : session.validity.detail}</span>
                  </button>
                );
              })
            ) : (
              <p className="testerConversationEmpty">当前视图没有匹配的已完成会话。</p>
            )}
            {data.nextCursor ? (
              <button
                type="button"
                className="loadMoreEvidence"
                disabled={loadingMore}
                onClick={() => void loadMoreEvidence()}
              >
                {loadingMore ? "正在加载…" : `加载更多证据（${testingSessions.length}/${data.sessionTotal}）`}
              </button>
            ) : null}
          </div>
          <div className="sessionDetail">
            {selectedSession ? (
              <>
                <div className="sessionMetricGrid">
                  <span>
                    <b>{testQualityLabel(selectedSession.quality)}</b>
                    质量
                  </span>
                  <span>
                    <b>{formatBytes(selectedSession.audioUpBytes)}</b>
                    麦克风上行
                  </span>
                  <span>
                    <b>{formatBytes(selectedSession.audioDownBytes + selectedSession.controlDownBytes)}</b>
                    下行
                  </span>
                  <span>
                    <b>
                      {selectedSession.avgLatencyMs}/{selectedSession.p95LatencyMs}ms
                    </b>
                    平均 / P95
                  </span>
                  <span>
                    <b>{selectedSession.errorEvents}</b>
                    错误
                  </span>
                  <span>
                    <b>{selectedSession.ttsFallbacks}</b>
                    TTS 回退
                  </span>
                  <span>
                    <b>{selectedSession.evaluation.score}</b>
                    评估分数
                  </span>
                  <span>
                    <b>{selectedSessionIssues}</b>
                    问题
                  </span>
                  <span>
                    <b>{selectedSession.validity.status === "valid" ? "有效" : "无效"}</b>
                    证据
                  </span>
                  <span>
                    <b>{selectedSession.deviceLabel}</b>
                    设备
                  </span>
                  <span>
                    <b>{selectedSession.browserLanguage}</b>
                    浏览器
                  </span>
                  <span>
                    <b>{selectedSession.networkType}</b>
                    网络
                  </span>
                  <span>
                    <b>{selectedSession.platform}</b>
                    平台
                  </span>
                  <span>
                    <b>
                      {selectedSession.appVersion} · {selectedSession.gitCommit}
                    </b>
                    构建
                  </span>
                  <span>
                    <b>{selectedSession.policyVersion}</b>
                    捕获策略
                  </span>
                  <span
                    className={`integrity-${selectedSession.evidenceIntegrity}`}
                    title={selectedSession.evidenceHash}
                  >
                    <b>
                      {selectedSession.evidenceIntegrity} · {selectedSession.evidenceHash.slice(0, 12)}…
                    </b>
                    证据 SHA-256
                  </span>
                  <span>
                    <b>
                      {selectedSession.audioQuality.outgoingFps}fps / {selectedSession.audioQuality.droppedFrames} 丢帧
                    </b>
                    音频传输
                  </span>
                  <span>
                    <b>
                      {selectedSession.audioQuality.clippingPct}% 削波 / {selectedSession.audioQuality.silencePct}% 静音
                    </b>
                    信号质量
                  </span>
                </div>
                {selectedSession.capturedEvaluation.score !== selectedSession.evaluation.score ||
                selectedSession.capturedEvaluation.quality !== selectedSession.evaluation.quality ? (
                  <p className="evaluationDriftNotice">
                    捕获结果 {selectedSession.capturedEvaluation.quality.toUpperCase()} /{" "}
                    {selectedSession.capturedEvaluation.score}；当前策略回放{" "}
                    {selectedSession.evaluation.quality.toUpperCase()} / {selectedSession.evaluation.score}。
                  </p>
                ) : null}
                {user.role === "admin" || user.role === "reviewer" ? (
                  <div className="evidenceNotes">
                    <label>
                      <span>审核证据备注</span>
                      <textarea
                        value={sessionNotes}
                        onChange={(event) => {
                          notesDirtyRef.current = event.target.value !== selectedSession.notes;
                          setNotesDirty(notesDirtyRef.current);
                          writeSessionNotes(event.target.value);
                        }}
                        placeholder="复现上下文、设备条件和调查记录…"
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
                      {currentDraftIsSaving ? "正在保存…" : "保存备注"}
                    </button>
                  </div>
                ) : null}
                <div className="sessionFlags">
                  {selectedSession.flags.length ? (
                    selectedSession.flags.map((flag) => <span key={flag}>{flag}</span>)
                  ) : (
                    <span>无标记</span>
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
                <div className="sessionTranscriptList">
                  {selectedSessionTurns.length ? (
                    selectedSessionTurns.map((turn, index) => (
                      <article
                        className={`testerTurn ${turn.speaker}`}
                        key={`${turn.sessionId}-${turn.at}-${turn.speaker}-${index}`}
                      >
                        <div>
                          <strong>{turn.speaker === "rider" ? "骑手" : "Max"}</strong>
                          <span>
                            {formatClockTime(turn.at)} · {turn.final ? "最终" : "实时"}
                          </span>
                          {turn.feedback ? <span className="turnFlagChip">⚑ {turn.feedback}</span> : null}
                        </div>
                        <p>{turn.text}</p>
                      </article>
                    ))
                  ) : (
                    <p className="testerConversationEmpty">此会话没有转写内容。</p>
                  )}
                </div>
              </>
            ) : (
              <p className="testerConversationEmpty">完成测试后选择测试员，即可在此回放会话。</p>
            )}
          </div>
        </div>
      </div>

      {user.role === "admin" || user.role === "reviewer" ? (
        <div className="issueWorkbench">
          <div className="reviewComposer">
            <span>所选证据</span>
            <strong>
              {selectedSession ? `${selectedSession.testCaseName} · ${selectedSession.testerId}` : "请先选择会话"}
            </strong>
            <div className="reviewFields">
              <label>
                <span>严重程度</span>
                <select
                  value={reviewSeverity}
                  onChange={(event) => setReviewSeverity(event.target.value as TestingReviewSeverity)}
                >
                  {REVIEW_SEVERITIES.map((severity) => (
                    <option key={severity} value={severity}>
                      {severity}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>负责人</span>
                <input value={reviewOwner} onChange={(event) => setReviewOwner(event.target.value)} />
              </label>
              <label className="wide">
                <span>标题</span>
                <input value={reviewTitle} onChange={(event) => setReviewTitle(event.target.value)} />
              </label>
              <label className="wide">
                <span>审核意见</span>
                <textarea
                  value={reviewComment}
                  onChange={(event) => setReviewComment(event.target.value)}
                  placeholder="记录复现步骤、预期行为与处置结论…"
                />
              </label>
            </div>
            <button
              type="button"
              disabled={reviewBusyTarget?.kind === "composer" || !selectedSession}
              onClick={() => void submitReview()}
            >
              {reviewBusyTarget?.kind === "composer" ? "正在保存…" : selectedReview ? "更新复核" : "新建复核"}
            </button>
          </div>
          <div className="reviewQueue">
            {(data.operations?.reviews ?? []).map((review) => (
              <article key={review.id} className={`reviewRow ${review.severity}`}>
                <button
                  type="button"
                  className="reviewEvidenceLink"
                  onClick={() => void selectReviewEvidence(review.sessionId)}
                >
                  <span>
                    {review.severity} · {review.status}
                  </span>
                  <strong>{review.title}</strong>
                  <small>
                    {review.owner} · {formatRelativeTime(review.updatedAt)}
                  </small>
                </button>
                <p>{review.comment || "暂无审核意见。"}</p>
                <select
                  aria-label={`复核状态 ${review.title}`}
                  value={review.status}
                  disabled={reviewBusyTarget?.kind === "status" && reviewBusyTarget.id === review.id}
                  onChange={(event) => void changeReviewStatus(review, event.target.value as TestingReviewStatus)}
                >
                  {REVIEW_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </select>
              </article>
            ))}
            {!data.operations?.reviews.length ? <p className="testerConversationEmpty">复核队列当前为空。</p> : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
