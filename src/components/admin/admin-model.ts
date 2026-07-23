import type { TesterSessionSummary, TesterStats } from "../../../shared/agent";
import type { AuthUser } from "../../lib/auth";

export type AppSurface = "voice" | "settings" | "admin";
export type AdminSection = "overview" | "releases" | "evidence" | "accounts" | "governance";

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

export function confirmationCopy(kind: "user" | "invite" | "session" | "tester" | "all-evidence", target: string) {
  const action = kind === "user" ? "删除" : kind === "invite" ? "撤销" : "清除";
  return `确认${action} ${target}？`;
}
