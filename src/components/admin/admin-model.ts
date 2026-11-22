import type { TesterSessionSummary, TesterStats, TestingStats } from "../../../shared/agent";
import type {
  TestingReviewSeverity,
  TestingReviewStatus,
  TestingRunStatus,
  TestingRun,
  TestingReview
} from "../../../shared/testing";
import { testingBuildsMatch } from "../../../shared/testing";
import type { AuthUser } from "../../lib/auth";
import { formatRelativeTime } from "../../lib/utils";
import { localized, type Language } from "../../lib/i18n";

export type AppSurface = "voice" | "settings" | "testing" | "admin";
export type Workspace = "testing" | "admin";
export type WorkspaceSection =
  | "overview"
  | "plans"
  | "evidence"
  | "quality"
  | "releases"
  | "diagnostics"
  | "policies"
  | "accounts"
  | "audit"
  | "studio"
  | "flow";
export type AdminDataStatus = "loading" | "ready" | "stale" | "error";

export function adminStatusAfterFailure(hasLoadedData: boolean): AdminDataStatus {
  return hasLoadedData ? "stale" : "error";
}

const ADMIN_SECTION_LABELS: Record<WorkspaceSection, string> = {
  overview: "概览",
  plans: "测试计划",
  releases: "发布验证",
  evidence: "测试记录",
  quality: "质量概览",
  diagnostics: "测试诊断",
  policies: "测试策略",
  accounts: "账号管理",
  audit: "审计历史",
  studio: "助手工作室",
  flow: "流程"
};

const ADMIN_SECTION_LABELS_EN: Record<WorkspaceSection, string> = {
  overview: "Overview",
  plans: "Test plans",
  releases: "Release validation",
  evidence: "Sessions",
  quality: "Quality overview",
  diagnostics: "Diagnostics",
  policies: "Testing policies",
  accounts: "Accounts",
  audit: "Audit history",
  studio: "Studio",
  flow: "Flow"
};

const TESTING_SECTIONS: WorkspaceSection[] = ["overview", "plans", "evidence"];
const QA_SECTIONS: WorkspaceSection[] = ["quality", "releases", "diagnostics", "policies"];

export function allowedTestingSections(role: AuthUser["role"]): WorkspaceSection[] {
  return role === "admin" || role === "reviewer" ? [...TESTING_SECTIONS, ...QA_SECTIONS] : [...TESTING_SECTIONS];
}

export function allowedAdminSections(role: AuthUser["role"]): WorkspaceSection[] {
  return role === "admin" ? ["overview", "studio", "flow", "accounts", "audit"] : [];
}

export function normalizeAdminSection(section: WorkspaceSection, role: AuthUser["role"]): WorkspaceSection {
  return allowedAdminSections(role).includes(section) ? section : "overview";
}

export function surfaceAfterAuthentication(surface: AppSurface, authenticated: boolean): AppSurface {
  return authenticated ? surface : "voice";
}

export function corpusIssueCount(users: TesterStats[]): number {
  return users.reduce((sum, user) => sum + user.qualityCounts.watch + user.qualityCounts.fail, 0);
}

export function mergeAdminSessions(
  current: TesterSessionSummary[],
  incoming: TesterSessionSummary[]
): TesterSessionSummary[] {
  const byId = new Map(current.map((item) => [item.sessionId, item]));
  for (const item of incoming) byId.set(item.sessionId, item);
  return [...byId.values()].sort((a, b) => b.endedAt - a.endedAt || b.sessionId.localeCompare(a.sessionId));
}

export function adminRoleLabel(role: AuthUser["role"], language: Language = "zh-CN"): string {
  if (language === "en-US") return role === "admin" ? "Administrator" : role === "reviewer" ? "Reviewer" : "Tester";
  return role === "admin" ? "管理员" : role === "reviewer" ? "审核员" : "测试员";
}

export function workspaceSectionLabel(section: WorkspaceSection, language: Language = "zh-CN"): string {
  return language === "en-US" ? ADMIN_SECTION_LABELS_EN[section] : ADMIN_SECTION_LABELS[section];
}

export function testingRunStatusLabel(status: TestingRunStatus, language: Language = "zh-CN"): string {
  if (language === "en-US") {
    if (status === "draft") return "Draft";
    if (status === "active") return "Active";
    if (status === "blocked") return "Blocked";
    if (status === "ready") return "Ready for approval";
    if (status === "approved") return "Approved";
    return "Archived";
  }
  if (status === "draft") return "草稿";
  if (status === "active") return "进行中";
  if (status === "blocked") return "受阻";
  if (status === "ready") return "待批准";
  if (status === "approved") return "已批准";
  return "已归档";
}

export function testingAssignmentStatusLabel(status: string, language: Language = "zh-CN"): string {
  if (language === "en-US") {
    if (status === "pending") return "Not started";
    if (status === "in-progress") return "In progress";
    if (status === "complete") return "Complete";
    if (status === "blocked") return "Blocked";
    return status;
  }
  if (status === "pending") return "待开始";
  if (status === "in-progress") return "进行中";
  if (status === "complete") return "已完成";
  if (status === "blocked") return "受阻";
  return status;
}

export function testingReviewStatusLabel(status: TestingReviewStatus, language: Language = "zh-CN"): string {
  if (language === "en-US")
    return status === "open"
      ? "Open"
      : status === "triaged"
        ? "Triaged"
        : status === "resolved"
          ? "Resolved"
          : "Waived";
  if (status === "open") return "待处理";
  if (status === "triaged") return "已分诊";
  if (status === "resolved") return "已解决";
  return "已豁免";
}

export function testingReviewSeverityLabel(severity: TestingReviewSeverity, language: Language = "zh-CN"): string {
  if (language === "en-US")
    return severity === "low" ? "Low" : severity === "medium" ? "Medium" : severity === "high" ? "High" : "Critical";
  if (severity === "low") return "低";
  if (severity === "medium") return "中";
  if (severity === "high") return "高";
  return "严重";
}

export function formatAdminRelativeTime(timestamp: number, language: Language = "zh-CN"): string {
  const relative = formatRelativeTime(timestamp);
  if (relative === "—") return relative;
  if (relative === "just now") return language === "en-US" ? "just now" : "刚刚";
  const match = relative.match(/^(\d+)([mhd]) ago$/);
  if (!match) return relative;
  if (language === "en-US") {
    const unit = match[2] === "m" ? "min" : match[2] === "h" ? "hr" : "day";
    return `${match[1]} ${unit} ago`;
  }
  const unit = match[2] === "m" ? "分钟" : match[2] === "h" ? "小时" : "天";
  return `${match[1]} ${unit}前`;
}

export function confirmationCopy(
  kind: "user" | "invite" | "session" | "tester" | "all-evidence",
  target: string,
  language: Language = "zh-CN"
) {
  if (language === "en-US") {
    const action = kind === "user" ? "Delete" : kind === "invite" ? "Revoke" : "Clear";
    return `Confirm ${action.toLowerCase()} ${target}?`;
  }
  const action = kind === "user" ? "删除" : kind === "invite" ? "撤销" : "清除";
  return `确认${action} ${target}？`;
}

/** Mirrors the release CLI's quality, regression and approval requirements. */
export function adminReleaseStatus(
  testing: TestingStats | null,
  approvedBuild?: string,
  expectedBuild?: string
): "waiting" | "fail" | "watch" | "ready" | "approved" {
  if (!testing || testing.releaseGate.status === "waiting") return "waiting";
  if (expectedBuild && !testingBuildsMatch(testing.releaseGate.build, expectedBuild)) return "waiting";
  const gate = testing.releaseGate;
  const regression = testing.regression;
  const baselineRequired = regression.baselineSource !== "none";
  if (gate.status === "fail" || (baselineRequired && regression.status === "fail")) return "fail";
  if (gate.status === "watch" || (baselineRequired && regression.status === "watch")) return "watch";
  if (baselineRequired && regression.status === "insufficient") return "waiting";
  return approvedBuild && testingBuildsMatch(gate.build, approvedBuild) ? "approved" : "ready";
}

/** Known client-side blockers; the approval API still checks authoritative evidence and all reviews. */
export function releaseApprovalBlockers(
  run: TestingRun,
  testing: TestingStats | null,
  reviews: TestingReview[] = [],
  language: Language = "zh-CN",
  expectedBuild?: string
): string[] {
  if (!testing) return [localized(language, "等待当前发布检查。", "Waiting for current release checks.")];
  const blockers: string[] = [];
  if (expectedBuild && !testingBuildsMatch(testing.releaseGate.build, expectedBuild))
    blockers.push(
      localized(
        language,
        "证据构建与当前构建不一致，请同步后再批准。",
        "Release evidence is for a different build. Refresh before approval."
      )
    );
  if (!testingBuildsMatch(run.build, testing.releaseGate.build))
    blockers.push(localized(language, "此运行与当前构建不匹配。", "This run does not match the current build."));
  if (testing.releaseGate.status !== "pass")
    blockers.push(
      ...(testing.releaseGate.blockers.length
        ? testing.releaseGate.blockers
        : [localized(language, "质量门禁必须通过。", "Quality gate must pass.")])
    );
  if (testing.regression.baselineSource !== "none" && testing.regression.status !== "pass") {
    blockers.push(
      ...testing.regression.findings.filter((finding) => finding.status !== "pass").map((finding) => finding.detail)
    );
    if (!testing.regression.findings.some((finding) => finding.status !== "pass"))
      blockers.push(localized(language, "回归对比必须通过。", "Regression comparison must pass."));
  }
  if (
    run.requirements.some(
      (requirement) =>
        run.assignments
          .filter((assignment) => assignment.requirementId === requirement.id)
          .reduce((sum, assignment) => sum + assignment.completedSessionIds.length, 0) <
        requirement.requiredValidSessions
    )
  )
    blockers.push(
      localized(language, "批准前必须完成全部覆盖要求。", "Complete every coverage requirement before approval.")
    );
  if (reviews.some((review) => review.runId === run.id && (review.status === "open" || review.status === "triaged")))
    blockers.push(
      localized(
        language,
        "批准前请解决本运行未完成的证据复核。",
        "Resolve this run's open evidence reviews before approval."
      )
    );
  return blockers;
}
