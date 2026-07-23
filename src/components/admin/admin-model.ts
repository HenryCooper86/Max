import type { TesterSessionSummary, TesterStats } from "../../../shared/agent";
import type { TestingReviewSeverity, TestingReviewStatus, TestingRunStatus } from "../../../shared/testing";
import type { AuthUser } from "../../lib/auth";
import { formatRelativeTime } from "../../lib/utils";

export type AppSurface = "voice" | "settings" | "admin";
export type AdminSection = "overview" | "releases" | "evidence" | "accounts" | "governance";
export type AdminDataStatus = "loading" | "ready" | "stale" | "error";

export function adminStatusAfterFailure(hasLoadedData: boolean): AdminDataStatus {
  return hasLoadedData ? "stale" : "error";
}

export const ADMIN_SECTION_LABELS: Record<AdminSection, string> = {
  overview: "概览",
  releases: "发布验证",
  evidence: "证据与问题",
  accounts: "账号管理",
  governance: "策略与审计"
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

export function adminRoleLabel(role: AuthUser["role"]): string {
  return role === "admin" ? "管理员" : role === "reviewer" ? "审核员" : "测试员";
}

export function testingRunStatusLabel(status: TestingRunStatus): string {
  if (status === "draft") return "草稿";
  if (status === "active") return "进行中";
  if (status === "blocked") return "受阻";
  if (status === "ready") return "待批准";
  if (status === "approved") return "已批准";
  return "已归档";
}

export function testingAssignmentStatusLabel(status: string): string {
  if (status === "pending") return "待开始";
  if (status === "in-progress") return "进行中";
  if (status === "complete") return "已完成";
  if (status === "blocked") return "受阻";
  return status;
}

export function testingReviewStatusLabel(status: TestingReviewStatus): string {
  if (status === "open") return "待处理";
  if (status === "triaged") return "已分诊";
  if (status === "resolved") return "已解决";
  return "已豁免";
}

export function testingReviewSeverityLabel(severity: TestingReviewSeverity): string {
  if (severity === "low") return "低";
  if (severity === "medium") return "中";
  if (severity === "high") return "高";
  return "严重";
}

export function formatAdminRelativeTime(timestamp: number): string {
  const relative = formatRelativeTime(timestamp);
  if (relative === "—") return relative;
  if (relative === "just now") return "刚刚";
  const match = relative.match(/^(\d+)([mhd]) ago$/);
  if (!match) return relative;
  const unit = match[2] === "m" ? "分钟" : match[2] === "h" ? "小时" : "天";
  return `${match[1]} ${unit}前`;
}

export function confirmationCopy(kind: "user" | "invite" | "session" | "tester" | "all-evidence", target: string) {
  const action = kind === "user" ? "删除" : kind === "invite" ? "撤销" : "清除";
  return `确认${action} ${target}？`;
}
