import type { TesterSessionSummary, TesterStats } from "../../../shared/agent";
import type { TestingReviewSeverity, TestingReviewStatus, TestingRunStatus } from "../../../shared/testing";
import type { AuthUser } from "../../lib/auth";
import { formatRelativeTime } from "../../lib/utils";
import type { Language } from "../../lib/i18n";

export type AppSurface = "voice" | "settings" | "admin";
export type AdminSection = "overview" | "releases" | "evidence" | "accounts" | "governance";
export type AdminDataStatus = "loading" | "ready" | "stale" | "error";

export function adminStatusAfterFailure(hasLoadedData: boolean): AdminDataStatus {
  return hasLoadedData ? "stale" : "error";
}

const ADMIN_SECTION_LABELS: Record<AdminSection, string> = {
  overview: "概览",
  releases: "发布验证",
  evidence: "证据与问题",
  accounts: "账号管理",
  governance: "策略与审计"
};

const ADMIN_SECTION_LABELS_EN: Record<AdminSection, string> = {
  overview: "Overview",
  releases: "Release validation",
  evidence: "Evidence & issues",
  accounts: "Accounts",
  governance: "Policy & audit"
};

const BASE_SECTIONS: AdminSection[] = ["overview", "releases", "evidence"];

export function allowedAdminSections(role: AuthUser["role"]): AdminSection[] {
  if (role === "admin") return [...BASE_SECTIONS, "accounts", "governance"];
  if (role === "reviewer") return [...BASE_SECTIONS, "governance"];
  return [...BASE_SECTIONS];
}

export function normalizeAdminSection(section: AdminSection, role: AuthUser["role"]): AdminSection {
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

export function adminSectionLabel(section: AdminSection, language: Language = "zh-CN"): string {
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
