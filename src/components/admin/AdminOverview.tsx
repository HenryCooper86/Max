import type { TesterSessionSummary, TestingStats } from "../../../shared/agent";
import type { TestingOperationsSnapshot, TestingQuality } from "../../../shared/testing";
import type { HelmetAgent } from "../../hooks/useHelmetAgent";
import { corpusIssueCount, formatAdminRelativeTime, testingRunStatusLabel } from "./admin-model";

const QUALITY_PRIORITY: Record<TestingQuality, number> = { fail: 3, watch: 2, pass: 1 };

function releaseStatusLabel(status: TestingStats["releaseGate"]["status"] | undefined) {
  if (status === "pass") return "PASS";
  if (status === "watch") return "WATCH";
  if (status === "fail") return "FAIL";
  return "等待";
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
  onOpenEvidence: (sessionId?: string) => void;
  onOpenReleases: () => void;
};

export function AdminOverview({ agent, testing, sessions, operations, onOpenEvidence, onOpenReleases }: Props) {
  const releaseGate = testing?.releaseGate;
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
        label: "发布阻断项",
        count: releaseGate?.blockers.length ?? 0,
        detail: releaseGate?.blockers[0] ?? "没有发布阻断项",
        onOpen: onOpenReleases
      },
      {
        key: "fail-evidence",
        tone: "alert",
        label: "FAIL 证据",
        count: failCount,
        detail: latestFail
          ? `${latestFail.testerId} · ${latestFail.testCaseName} · ${formatAdminRelativeTime(latestFail.endedAt)}`
          : "当前已加载页面没有 FAIL 证据",
        onOpen: () => onOpenEvidence(latestFail?.sessionId)
      },
      {
        key: "watch-evidence",
        tone: "warn",
        label: "WATCH 证据",
        count: watchCount,
        detail: latestWatch
          ? `${latestWatch.testerId} · ${latestWatch.testCaseName} · ${formatAdminRelativeTime(latestWatch.endedAt)}`
          : "当前已加载页面没有 WATCH 证据",
        onOpen: () => onOpenEvidence(latestWatch?.sessionId)
      },
      {
        key: "invalid-evidence",
        tone: "warn",
        label: "无效证据",
        count: invalidCount,
        detail: latestInvalid
          ? `${latestInvalid.testerId} · ${latestInvalid.validity.detail}`
          : "当前已加载页面没有无效证据",
        onOpen: () => onOpenEvidence(latestInvalid?.sessionId)
      },
      {
        key: "missing-coverage",
        tone: "warn",
        label: "发布覆盖缺口",
        count: missingCases.length,
        detail: missingCases[0]?.testCaseName ?? "必需用例覆盖完整",
        onOpen: onOpenReleases
      }
    ] satisfies QueueItem[]
  ).filter((item) => item.count > 0);
  const recentRuns = [...(operations?.runs ?? [])].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5);

  return (
    <section className="adminSectionCard adminOverview" aria-label="管理概览">
      <div className="panelHeader adminSectionHeader">
        <div>
          <h2>质量与发布概览</h2>
          <span>
            当前构建 {agent.health?.build?.gitCommit ?? releaseGate?.build ?? "local"} ·{" "}
            {testing ? `${testing.windowMinutes} 分钟窗口` : "等待测试数据"}
          </span>
        </div>
      </div>

      <div className="testingOpsStrip adminMetricGrid" aria-label="关键质量指标">
        <button type="button" className={`opsCard ${statusTone(releaseGate?.status)}`} onClick={onOpenReleases}>
          <span>发布门禁</span>
          <strong className={`adminStatus ${statusTone(releaseGate?.status)}`}>
            {releaseStatusLabel(releaseGate?.status)}
          </strong>
          <p>{releaseGate ? `${releaseGate.validSessions} 有效 · ${releaseGate.invalidSessions} 无效` : "等待证据"}</p>
        </button>
        <button
          type="button"
          className={`opsCard ${issueCount ? "alert" : "good"}`}
          onClick={() => onOpenEvidence(latestIssue?.sessionId)}
        >
          <span>待复核证据</span>
          <strong className={`adminStatus ${issueCount ? "alert" : "good"}`}>{issueCount}</strong>
          <p>
            {failCount} FAIL · {watchCount} WATCH · 全量服务端统计
          </p>
        </button>
        <button
          type="button"
          className={`opsCard ${validEvidenceTone}`}
          onClick={() => onOpenEvidence(latestInvalid?.sessionId)}
        >
          <span>有效证据</span>
          <strong className={`adminStatus ${validEvidenceTone}`}>{testing?.totals.validTestSessions ?? 0}</strong>
          <p>
            {hasDecisionGradeEvidence
              ? `${invalidCount} 无效 · ${testing?.history.persistent ? "持久化历史" : "仅内存历史"}`
              : "等待门禁证据"}
          </p>
        </button>
        <button type="button" className={`opsCard ${p95Tone}`} onClick={onOpenReleases}>
          <span>{releaseGate ? "门禁 P95 首音" : "语料 P95 首音"}</span>
          <strong className={`adminStatus ${p95Tone}`}>{p95LatencyMs > 0 ? `${p95LatencyMs}ms` : "等待"}</strong>
          <p>门禁阈值 {p95ThresholdMs ?? "—"}ms</p>
        </button>
      </div>

      <div className="testingDecisionGrid adminWorkGrid">
        <section className="decisionPanel adminSectionCard adminSectionInset" aria-label="优先工作队列">
          <div className="decisionPanelHead">
            <span>优先工作队列</span>
            <strong className={queue.some((item) => item.tone === "alert") ? "alert" : "warn"}>
              {queue.length ? `${queue.length} 类待处理` : "PASS"}
            </strong>
          </div>
          <div className="sessionList">
            {queue.length ? (
              queue.map((item) => (
                <button type="button" className={`sessionButton ${item.tone}`} key={item.key} onClick={item.onOpen}>
                  <span>{item.label}</span>
                  <strong>{item.count} 项</strong>
                  <span>{item.detail}</span>
                </button>
              ))
            ) : (
              <p className="testerConversationEmpty">当前没有阻断项或待复核证据。</p>
            )}
          </div>
        </section>

        <section className="decisionPanel adminSectionCard adminSectionInset" aria-label="近期发布进度">
          <div className="decisionPanelHead">
            <span>近期发布进度</span>
            <button type="button" onClick={onOpenReleases}>
              查看发布验证
            </button>
          </div>
          <div className="sessionList">
            {recentRuns.length ? (
              recentRuns.map((run) => {
                const completed = run.assignments.filter((assignment) => assignment.status === "complete").length;
                return (
                  <button type="button" className="sessionButton" key={run.id} onClick={onOpenReleases}>
                    <span className={`sessionQuality adminStatus ${statusTone(run.status)}`}>
                      {testingRunStatusLabel(run.status)}
                    </span>
                    <strong>{run.name}</strong>
                    <span>
                      构建 {run.build} · {completed}/{run.assignments.length} 项任务完成
                    </span>
                    <span>更新于 {formatAdminRelativeTime(run.updatedAt)}</span>
                  </button>
                );
              })
            ) : (
              <p className="testerConversationEmpty">暂无可见的发布运行记录。</p>
            )}
          </div>
        </section>
      </div>
    </section>
  );
}
