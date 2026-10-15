import type { TesterSessionSummary, TestingStats } from "../../../shared/agent";
import { testingBuildsMatch } from "../../../shared/testing";
import type { TestingOperationsSnapshot, TestingQuality, TestingRun } from "../../../shared/testing";
import type { HelmetAgent } from "../../hooks/useHelmetAgent";
import { useLanguage } from "../LanguageToggle";
import { localized } from "../../lib/i18n";
import {
  adminReleaseStatus,
  corpusIssueCount,
  formatAdminRelativeTime,
  releaseApprovalBlockers,
  testingRunStatusLabel,
  type AdminDataStatus
} from "./admin-model";

const QUALITY_PRIORITY: Record<TestingQuality, number> = { fail: 3, watch: 2, pass: 1 };

function releaseStatusLabel(status: ReturnType<typeof adminReleaseStatus>, language: "zh-CN" | "en-US") {
  if (status === "approved") return localized(language, "已批准", "APPROVED");
  if (status === "ready") return localized(language, "待批准", "Awaiting approval");
  if (status === "watch") return "WATCH";
  if (status === "fail") return localized(language, "受阻", "BLOCKED");
  return localized(language, "等待", "Waiting");
}

function statusTone(status: string | undefined) {
  if (status === "pass" || status === "approved" || status === "ready") return "good";
  if (status === "fail" || status === "blocked") return "alert";
  return "warn";
}

type QueueItem = {
  key: string;
  tone: "alert" | "warn";
  label: string;
  count: number;
  detail: string;
  onOpen: () => void;
};

type Props = {
  agent: HelmetAgent;
  testing: TestingStats | null;
  sessions: TesterSessionSummary[];
  operations: TestingOperationsSnapshot | null;
  runs?: TestingRun[];
  dataStatus?: AdminDataStatus;
  onOpenEvidence: (sessionId?: string) => void;
  onOpenReleases: () => void;
};

export function AdminOverview({
  agent,
  testing,
  sessions,
  operations,
  runs = [],
  dataStatus = "ready",
  onOpenEvidence,
  onOpenReleases
}: Props) {
  const { language } = useLanguage();
  const releaseGate = testing?.releaseGate;
  const numericReleaseStatus = adminReleaseStatus(
    testing,
    operations?.approvedBaselineBuild,
    agent.health?.build?.gitCommit
  );
  const currentRun = [...(operations?.runs ?? runs)]
    .filter((run) => run.status !== "archived" && testingBuildsMatch(run.build, releaseGate?.build))
    .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)[0];
  const approvalBlockers =
    currentRun && operations
      ? releaseApprovalBlockers(currentRun, testing, operations?.reviews, language, agent.health?.build?.gitCommit)
      : [];
  if (currentRun?.status === "blocked")
    approvalBlockers.unshift(localized(language, "当前发布运行已受阻。", "The current release run is blocked."));
  const releaseStatus =
    dataStatus !== "ready" || numericReleaseStatus === "waiting"
      ? "waiting"
      : approvalBlockers.length
        ? "fail"
        : operations
          ? numericReleaseStatus
          : "waiting";
  const releaseTone = releaseStatus === "ready" ? "warn" : statusTone(releaseStatus);
  const regression = testing?.regression;
  const regressionFindings =
    regression?.baselineSource !== "none"
      ? (regression?.findings.filter((finding) => finding.status !== "pass") ?? [])
      : [];
  const releaseBlockers = [
    ...new Set([
      ...(releaseGate?.blockers ?? []),
      ...regressionFindings.map((finding) => finding.detail),
      ...approvalBlockers
    ])
  ];
  if (dataStatus !== "ready")
    releaseBlockers.unshift(localized(language, "发布数据尚未同步", "Release data is not current."));
  else if (!operations && !approvalBlockers.length)
    releaseBlockers.unshift(localized(language, "等待发布复核信息。", "Waiting for release review."));
  if (
    releaseGate &&
    agent.health?.build?.gitCommit &&
    !testingBuildsMatch(releaseGate.build, agent.health.build.gitCommit)
  )
    releaseBlockers.unshift(
      localized(
        language,
        "证据构建与当前构建不一致，请同步后再批准。",
        "Release evidence is for a different build. Refresh before approval."
      )
    );
  if (regression?.baselineSource !== "none" && regression && regression.status !== "pass" && !regressionFindings.length)
    releaseBlockers.push(localized(language, "回归对比尚未通过", "Regression comparison has not passed."));
  const issueCount = corpusIssueCount(testing?.users ?? []);
  const failCount = (testing?.users ?? []).reduce((sum, tester) => sum + tester.qualityCounts.fail, 0);
  const watchCount = (testing?.users ?? []).reduce((sum, tester) => sum + tester.qualityCounts.watch, 0);
  const invalidCount = testing?.totals.invalidTestSessions ?? 0;
  const p95LatencyMs = releaseGate?.p95LatencyMs ?? testing?.totals.p95LatencyMs ?? 0;
  const p95ThresholdMs = releaseGate?.criteria.maxP95LatencyMs;
  const hasDecisionGradeEvidence = releaseGate
    ? releaseGate.status !== "waiting" && releaseGate.validSessions + releaseGate.invalidSessions > 0
    : (testing?.totals.totalTestSessions ?? 0) > 0;
  const validEvidenceTone = !hasDecisionGradeEvidence || invalidCount > 0 ? "warn" : "good";
  const p95Tone =
    !hasDecisionGradeEvidence || p95ThresholdMs === undefined || p95LatencyMs <= 0
      ? "warn"
      : p95LatencyMs > p95ThresholdMs
        ? "alert"
        : "good";
  const missingCases = releaseGate?.cases.filter((testCase) => testCase.status === "missing") ?? [];
  const latestIssue = [...sessions]
    .filter(
      (session) => session.quality !== "pass" || session.flags.length > 0 || session.validity.status === "invalid"
    )
    .sort((a, b) => QUALITY_PRIORITY[b.quality] - QUALITY_PRIORITY[a.quality] || b.endedAt - a.endedAt)[0];
  const latestFail = [...sessions]
    .filter((session) => session.quality === "fail")
    .sort((a, b) => b.endedAt - a.endedAt)[0];
  const latestWatch = [...sessions]
    .filter((session) => session.quality === "watch")
    .sort((a, b) => b.endedAt - a.endedAt)[0];
  const latestInvalid = [...sessions]
    .filter((session) => session.validity.status === "invalid")
    .sort((a, b) => b.endedAt - a.endedAt)[0];
  const queue = (
    [
      {
        key: "release-blockers",
        tone: "alert",
        label: localized(language, "发布阻断项", "Release blockers"),
        count: releaseBlockers.length,
        detail: releaseBlockers[0] ?? localized(language, "没有发布阻断项", "No release blockers"),
        onOpen: onOpenReleases
      },
      {
        key: "fail-evidence",
        tone: "alert",
        label: localized(language, "FAIL 证据", "FAIL evidence"),
        count: failCount,
        detail: latestFail
          ? `${latestFail.testerId} · ${latestFail.testCaseName} · ${formatAdminRelativeTime(latestFail.endedAt, language)}`
          : localized(language, "当前已加载页面没有 FAIL 证据", "No FAIL evidence in the loaded page"),
        onOpen: () => onOpenEvidence(latestFail?.sessionId)
      },
      {
        key: "watch-evidence",
        tone: "warn",
        label: localized(language, "WATCH 证据", "WATCH evidence"),
        count: watchCount,
        detail: latestWatch
          ? `${latestWatch.testerId} · ${latestWatch.testCaseName} · ${formatAdminRelativeTime(latestWatch.endedAt, language)}`
          : localized(language, "当前已加载页面没有 WATCH 证据", "No WATCH evidence in the loaded page"),
        onOpen: () => onOpenEvidence(latestWatch?.sessionId)
      },
      {
        key: "invalid-evidence",
        tone: "warn",
        label: localized(language, "无效证据", "Invalid evidence"),
        count: invalidCount,
        detail: latestInvalid
          ? `${latestInvalid.testerId} · ${latestInvalid.validity.detail}`
          : localized(language, "当前已加载页面没有无效证据", "No invalid evidence in the loaded page"),
        onOpen: () => onOpenEvidence(latestInvalid?.sessionId)
      },
      {
        key: "missing-coverage",
        tone: "warn",
        label: localized(language, "发布覆盖缺口", "Release coverage gaps"),
        count: missingCases.length,
        detail: missingCases[0]?.testCaseName ?? localized(language, "必需用例覆盖完整", "Required cases are covered"),
        onOpen: onOpenReleases
      }
    ] satisfies QueueItem[]
  ).filter((item) => item.count > 0);
  const recentRuns = [...(operations?.runs ?? [])].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5);

  return (
    <section
      className="adminSectionCard adminOverview"
      aria-label={language === "en-US" ? "Admin overview" : "管理概览"}
    >
      <div className="panelHeader adminSectionHeader">
        <div>
          <h2>{language === "en-US" ? "Quality & release overview" : "质量与发布概览"}</h2>
          <span>
            {localized(language, "当前构建", "Current build")}{" "}
            {agent.health?.build?.gitCommit ?? releaseGate?.build ?? "local"} ·{" "}
            {testing
              ? language === "en-US"
                ? `${testing.windowMinutes}-minute window`
                : `${testing.windowMinutes} 分钟窗口`
              : language === "en-US"
                ? "Waiting for test data"
                : "等待测试数据"}
          </span>
        </div>
      </div>

      <div
        className="testingOpsStrip adminMetricGrid"
        aria-label={localized(language, "关键质量指标", "Key quality metrics")}
      >
        <button type="button" className={`opsCard ${releaseTone}`} onClick={onOpenReleases}>
          <span>{localized(language, "发布门禁", "Release gate")}</span>
          <strong className={`adminStatus ${releaseTone}`}>{releaseStatusLabel(releaseStatus, language)}</strong>
          <p>
            {releaseGate
              ? `${releaseGate.validSessions} ${localized(language, "有效", "valid")} · ${releaseGate.invalidSessions} ${localized(language, "无效", "invalid")}`
              : localized(language, "等待证据", "Waiting for evidence")}
          </p>
          {releaseGate && regression ? (
            <p>
              {localized(language, "质量", "Quality")} {releaseGate.status.toUpperCase()} ·{" "}
              {localized(language, "回归", "Regression")}{" "}
              {regression.baselineSource === "none"
                ? localized(language, "无基线", "No baseline")
                : regression.status.toUpperCase()}
            </p>
          ) : null}
        </button>
        <button
          type="button"
          className={`opsCard ${issueCount ? "alert" : "good"}`}
          onClick={() => onOpenEvidence(latestIssue?.sessionId)}
        >
          <span>{localized(language, "待复核证据", "Evidence to review")}</span>
          <strong className={`adminStatus ${issueCount ? "alert" : "good"}`}>{issueCount}</strong>
          <p>
            {failCount} FAIL · {watchCount} WATCH · {localized(language, "近期测试者记录", "Recent tester history")}
          </p>
        </button>
        <button
          type="button"
          className={`opsCard ${validEvidenceTone}`}
          onClick={() => onOpenEvidence(latestInvalid?.sessionId)}
        >
          <span>{localized(language, "有效证据", "Valid evidence")}</span>
          <strong className={`adminStatus ${validEvidenceTone}`}>{testing?.totals.validTestSessions ?? 0}</strong>
          <p>
            {hasDecisionGradeEvidence
              ? `${invalidCount} ${localized(language, "无效", "invalid")} · ${testing?.history.persistent ? localized(language, "近期已保存记录", "Recent saved history") : localized(language, "近期内存记录", "Recent memory history")}`
              : localized(language, "等待门禁证据", "Waiting for gate evidence")}
          </p>
        </button>
        <button type="button" className={`opsCard ${p95Tone}`} onClick={onOpenReleases}>
          <span>
            {releaseGate
              ? localized(language, "门禁 P95 首音", "Gate P95 first audio")
              : localized(language, "语料 P95 首音", "Corpus P95 first audio")}
          </span>
          <strong className={`adminStatus ${p95Tone}`}>
            {p95LatencyMs > 0 ? `${p95LatencyMs}ms` : localized(language, "等待", "Waiting")}
          </strong>
          <p>
            {localized(language, "门禁阈值", "Gate threshold")} {p95ThresholdMs ?? "—"}ms
          </p>
        </button>
      </div>

      <div className="testingDecisionGrid adminWorkGrid">
        <section
          className="decisionPanel adminSectionCard adminSectionInset"
          aria-label={localized(language, "优先工作队列", "Priority work queue")}
        >
          <div className="decisionPanelHead">
            <span>{localized(language, "优先工作队列", "Priority work queue")}</span>
            <strong className={queue.some((item) => item.tone === "alert") ? "alert" : "warn"}>
              {queue.length ? `${queue.length} ${localized(language, "类待处理", "categories pending")}` : "PASS"}
            </strong>
          </div>
          <div className="sessionList">
            {queue.length ? (
              queue.map((item) => (
                <button type="button" className={`sessionButton ${item.tone}`} key={item.key} onClick={item.onOpen}>
                  <span>{item.label}</span>
                  <strong>
                    {item.count} {localized(language, "项", "items")}
                  </strong>
                  <span>{item.detail}</span>
                </button>
              ))
            ) : (
              <p className="testerConversationEmpty">
                {localized(language, "当前没有阻断项或待复核证据。", "No blockers or evidence awaiting review.")}
              </p>
            )}
          </div>
        </section>

        <section
          className="decisionPanel adminSectionCard adminSectionInset"
          aria-label={localized(language, "近期发布进度", "Recent release progress")}
        >
          <div className="decisionPanelHead">
            <span>{localized(language, "近期发布进度", "Recent release progress")}</span>
            <button type="button" onClick={onOpenReleases}>
              {localized(language, "查看发布验证", "View release validation")}
            </button>
          </div>
          <div className="sessionList">
            {recentRuns.length ? (
              recentRuns.map((run) => {
                const completed = run.assignments.filter((assignment) => assignment.status === "complete").length;
                return (
                  <button type="button" className="sessionButton" key={run.id} onClick={onOpenReleases}>
                    <span className={`sessionQuality adminStatus ${statusTone(run.status)}`}>
                      {testingRunStatusLabel(run.status, language)}
                    </span>
                    <strong>{run.name}</strong>
                    <span>
                      {localized(language, "构建", "Build")} {run.build} · {completed}/{run.assignments.length}{" "}
                      {localized(language, "项任务完成", "tasks complete")}
                    </span>
                    <span>
                      {localized(language, "更新于", "Updated")} {formatAdminRelativeTime(run.updatedAt, language)}
                    </span>
                  </button>
                );
              })
            ) : (
              <p className="testerConversationEmpty">
                {localized(language, "暂无可见的发布运行记录。", "No visible release runs.")}
              </p>
            )}
          </div>
        </section>
      </div>
    </section>
  );
}
