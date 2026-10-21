import { useEffect, useMemo, useState } from "react";
import type { TesterSessionSummary } from "../../../shared/agent";
import {
  findTestingTestCase,
  TESTING_PLATFORMS,
  type TestingAssignment,
  type TestingAuditEvent,
  type TestingPlatform,
  type TestingPolicy,
  type TestingReview,
  type TestingReviewSeverity,
  type TestingReviewStatus,
  type TestingRun,
  type TestingRunStatus
} from "../../../shared/testing";
import type { AuthUser } from "../../lib/auth";
import { useLanguage } from "../LanguageToggle";
import { localized, type Language } from "../../lib/i18n";
import {
  adminRoleLabel,
  formatAdminRelativeTime,
  testingAssignmentStatusLabel,
  testingReviewSeverityLabel,
  testingReviewStatusLabel,
  testingRunStatusLabel
} from "./admin-model";
import { readWorkspaceLocation, setWorkspaceLocation, useWorkspaceLocation } from "./workspace-location";
import type { AdminTestingData } from "./useAdminTestingData";

type GovernanceView = "policy" | "audit";
type Notice = { tone: "success" | "error"; message: string };
type AuditFilters = { search: string; actor: string; action: string; from: string; to: string };

type Props = {
  view: GovernanceView;
  user: AuthUser;
  data: AdminTestingData;
};

type AuditLookup = {
  runs: Map<string, TestingRun>;
  assignments: Map<string, { assignment: TestingAssignment; run: TestingRun }>;
  reviews: Map<string, TestingReview>;
  sessions: Map<string, TesterSessionSummary>;
  policies: Map<string, TestingPolicy>;
};

type ReleaseThresholdField = {
  group: "release";
  key: keyof TestingPolicy["release"];
  min: number;
  max: number;
};

type RegressionThresholdField = {
  group: "regression";
  key: keyof TestingPolicy["regression"];
  min: number;
  max: number;
};

type PolicyThresholdField = ReleaseThresholdField | RegressionThresholdField;

/** Mirrors the relay's createTestingPolicy bounds so the form explains what
 * the server would otherwise clamp silently. */
const RELEASE_THRESHOLD_FIELDS: readonly ReleaseThresholdField[] = [
  { group: "release", key: "maxFailSessions", min: 0, max: 10_000 },
  { group: "release", key: "maxWatchSessions", min: 0, max: 10_000 },
  { group: "release", key: "maxInvalidSessions", min: 0, max: 10_000 },
  { group: "release", key: "maxP95LatencyMs", min: 50, max: 60_000 },
  { group: "release", key: "minStandardSessions", min: 1, max: 100 },
  { group: "release", key: "minSafetyCriticalSessions", min: 1, max: 100 }
];

const REGRESSION_THRESHOLD_FIELDS: readonly RegressionThresholdField[] = [
  { group: "regression", key: "minimumMatchedCohortSessions", min: 1, max: 100 },
  { group: "regression", key: "latencyWatchDeltaMs", min: 0, max: 60_000 },
  { group: "regression", key: "latencyFailDeltaMs", min: 0, max: 60_000 },
  { group: "regression", key: "scoreWatchDelta", min: -100, max: 0 },
  { group: "regression", key: "scoreFailDelta", min: -100, max: 0 }
];

const POLICY_THRESHOLD_FIELDS: readonly PolicyThresholdField[] = [
  ...RELEASE_THRESHOLD_FIELDS,
  ...REGRESSION_THRESHOLD_FIELDS
];

const POLICY_FIELD_LABELS: Record<string, readonly [string, string]> = {
  "release.maxFailSessions": ["允许失败证据数", "Allowed failing evidence"],
  "release.maxWatchSessions": ["允许观察证据数", "Allowed watch evidence"],
  "release.maxInvalidSessions": ["允许无效证据数", "Allowed invalid evidence"],
  "release.maxP95LatencyMs": ["发布 P95 上限（ms）", "Release P95 limit (ms)"],
  "release.minStandardSessions": ["标准用例最少有效会话", "Min valid sessions per standard case"],
  "release.minSafetyCriticalSessions": ["安全用例最少样本", "Min samples per safety case"],
  "release.requiredPlatforms": ["必需平台", "Required platforms"],
  "regression.minimumMatchedCohortSessions": ["回归配对最少会话", "Min matched cohort sessions"],
  "regression.latencyWatchDeltaMs": ["延迟观察阈值（ms）", "Latency watch delta (ms)"],
  "regression.latencyFailDeltaMs": ["延迟失败阈值（ms）", "Latency fail delta (ms)"],
  "regression.scoreWatchDelta": ["评分观察降幅", "Score watch delta"],
  "regression.scoreFailDelta": ["评分失败降幅", "Score fail delta"],
  description: ["描述", "Description"]
};

/** Every action the relay writes to the audit trail, plus the legacy
 * policy.publish spelling kept for events recorded by older builds. */
const AUDIT_ACTION_LABELS: Record<string, readonly [string, string]> = {
  "policy.created": ["发布策略版本", "Published policy version"],
  "policy.publish": ["发布策略版本", "Published policy version"],
  "run.created": ["创建发布验证", "Created release run"],
  "run.updated": ["更新发布验证", "Updated release run"],
  "run.ready": ["发布验证就绪", "Release run ready"],
  "run.evidence-revoked": ["撤销验证证据", "Revoked run evidence"],
  "assignment.created": ["分配测试任务", "Assigned testing task"],
  "assignment.updated": ["更新任务分配", "Updated assignment"],
  "assignment.evidence-credited": ["证据计入任务", "Evidence credited to assignment"],
  "review.created": ["新建评审", "Created review"],
  "review.updated": ["更新评审", "Updated review"],
  "baseline.approved": ["批准基线构建", "Approved baseline build"],
  "baseline.revoked": ["撤销基线构建", "Revoked baseline build"],
  "session.notes-updated": ["更新会话备注", "Updated session notes"],
  "session-data.cleared": ["清除会话数据", "Cleared session data"],
  "account.role-changed": ["变更账号角色", "Changed account role"]
};

const AUDIT_DETAIL_LABELS: Record<string, readonly [string, string]> = {
  previousVersion: ["原版本", "Previous version"],
  build: ["构建", "Build"],
  requirements: ["需求数", "Requirements"],
  status: ["状态", "Status"],
  owner: ["负责人", "Owner"],
  assignee: ["执行人", "Assignee"],
  runId: ["所属验证", "Run"],
  requirementId: ["需求", "Requirement"],
  sessionId: ["会话", "Session"],
  completed: ["已计入", "Credited"],
  required: ["所需数量", "Required"],
  role: ["新角色", "New role"],
  severity: ["严重级别", "Severity"],
  notesLength: ["备注长度", "Notes length"],
  scope: ["范围", "Scope"],
  removedTesters: ["移除测试员", "Removed testers"],
  removedSessions: ["移除会话", "Removed sessions"],
  revokedSessions: ["撤销会话", "Revoked sessions"],
  coverageComplete: ["覆盖已完成", "Coverage complete"],
  clearedEvidence: ["已清除证据", "Cleared evidence"]
};

const AUDIT_TARGET_TYPE_LABELS: Record<TestingAuditEvent["targetType"], readonly [string, string]> = {
  run: ["发布验证", "Release run"],
  assignment: ["测试任务", "Assignment"],
  review: ["评审", "Review"],
  session: ["会话", "Session"],
  policy: ["策略", "Policy"],
  account: ["账号", "Account"],
  baseline: ["基线构建", "Baseline build"]
};

const PLATFORM_LABELS: Record<TestingPlatform, readonly [string, string]> = {
  web: ["网页端", "Web"],
  ios: ["iOS", "iOS"],
  android: ["Android", "Android"],
  embedded: ["嵌入式", "Embedded"],
  unknown: ["未知", "Unknown"]
};

const POLICY_PICKER_PLATFORMS: readonly TestingPlatform[] = TESTING_PLATFORMS.filter(
  (platform) => platform !== "unknown"
);

const EMPTY_AUDIT_FILTERS: AuditFilters = { search: "", actor: "", action: "all", from: "", to: "" };

function labelPair(pair: readonly [string, string] | undefined, language: Language, fallback: string): string {
  if (!pair) return fallback;
  return language === "en-US" ? pair[1] : pair[0];
}

function detailValue(value: unknown) {
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

const RUN_STATUS_VALUES: readonly string[] = ["draft", "active", "blocked", "ready", "approved", "archived"];
const REVIEW_STATUS_VALUES: readonly string[] = ["open", "triaged", "resolved", "waived"];

function formatAbsoluteTime(timestamp: number, language: Language): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "—";
  return new Intl.DateTimeFormat(language === "en-US" ? "en-US" : "zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(timestamp));
}

function sessionLabel(session: TesterSessionSummary): string {
  return `${session.testCaseName} · ${session.testerId}`;
}

function scopeLabel(value: unknown, lookup: AuditLookup, language: Language): string {
  if (value === "all") return localized(language, "全部证据", "All evidence");
  if (value && typeof value === "object") {
    const scope = value as { scope?: unknown; testerKey?: unknown; sessionId?: unknown };
    if (scope.scope === "all") return localized(language, "全部证据", "All evidence");
    if (scope.scope === "tester" && typeof scope.testerKey === "string") {
      return `${localized(language, "测试员", "Tester")} ${scope.testerKey}`;
    }
    if (scope.scope === "session" && typeof scope.sessionId === "string") {
      const session = lookup.sessions.get(scope.sessionId);
      return session ? sessionLabel(session) : scope.sessionId;
    }
  }
  return detailValue(value);
}

function buildAuditLookup(data: AdminTestingData): AuditLookup {
  const runs = new Map<string, TestingRun>();
  for (const run of data.operations?.runs ?? []) runs.set(run.id, run);
  for (const run of data.runs) if (!runs.has(run.id)) runs.set(run.id, run);
  const assignments = new Map<string, { assignment: TestingAssignment; run: TestingRun }>();
  for (const run of runs.values()) {
    for (const assignment of run.assignments) {
      assignments.set(assignment.id, { assignment, run });
    }
  }
  const reviews = new Map<string, TestingReview>();
  for (const review of data.operations?.reviews ?? []) reviews.set(review.id, review);
  const sessions = new Map<string, TesterSessionSummary>();
  for (const session of data.sessions) sessions.set(session.sessionId, session);
  for (const [sessionId, detail] of Object.entries(data.sessionDetails)) {
    if (!sessions.has(sessionId)) sessions.set(sessionId, detail);
  }
  const policies = new Map<string, TestingPolicy>();
  for (const policy of data.policies) policies.set(policy.version, policy);
  return { runs, assignments, reviews, sessions, policies };
}

/** Human-readable target plus a shareable deep link. href stays null when the
 * record is no longer loaded, so the UI never links to missing records. */
function auditTargetDisplay(
  event: TestingAuditEvent,
  lookup: AuditLookup,
  language: Language
): { href: string | null; text: string } {
  switch (event.targetType) {
    case "run": {
      const run = lookup.runs.get(event.targetId);
      return {
        href: run ? `#/testing/releases?run=${encodeURIComponent(run.id)}` : null,
        text: run ? run.name : localized(language, "发布运行未加载", "Release run not loaded")
      };
    }
    case "assignment": {
      const found = lookup.assignments.get(event.targetId);
      return {
        href: found ? `#/testing/releases?run=${encodeURIComponent(found.run.id)}` : null,
        text: found
          ? `${found.run.name} · ${found.assignment.assignee}`
          : localized(language, "测试任务未加载", "Assignment not loaded")
      };
    }
    case "session": {
      const session = lookup.sessions.get(event.targetId);
      if (session) {
        return {
          href: `#/testing/evidence?session=${encodeURIComponent(session.sessionId)}`,
          text: sessionLabel(session)
        };
      }
      return {
        href: null,
        text:
          event.detail.scope === undefined
            ? localized(language, "会话未加载", "Session not loaded")
            : scopeLabel(event.detail.scope, lookup, language)
      };
    }
    case "review": {
      const review = lookup.reviews.get(event.targetId);
      return {
        href: review
          ? `#/testing/evidence?session=${encodeURIComponent(review.sessionId)}&tab=review&reviewId=${encodeURIComponent(review.id)}`
          : null,
        text: review ? review.title : localized(language, "复核记录未加载", "Review not loaded")
      };
    }
    case "policy": {
      return {
        href: lookup.policies.has(event.targetId)
          ? `#/testing/policies?policy=${encodeURIComponent(event.targetId)}`
          : null,
        text: event.targetId
      };
    }
    case "baseline": {
      const runId = typeof event.detail.runId === "string" ? event.detail.runId : null;
      const run = runId ? lookup.runs.get(runId) : undefined;
      return {
        href: run ? `#/testing/releases?run=${encodeURIComponent(run.id)}` : null,
        text: event.targetId
      };
    }
    case "account": {
      // Accounts are not part of the testing snapshot, so the audit trail can
      // only hand off to the accounts section, pre-filtered to the actor.
      return {
        href: `#/admin/accounts?q=${encodeURIComponent(event.targetId)}`,
        text: event.targetId
      };
    }
    default:
      return { href: null, text: `@${event.targetId}` };
  }
}

function formatAuditValue(
  key: string,
  value: unknown,
  detail: Record<string, unknown>,
  lookup: AuditLookup,
  language: Language
): string {
  if (typeof value === "boolean") return localized(language, value ? "是" : "否", value ? "Yes" : "No");
  switch (key) {
    case "status":
      if (typeof value !== "string") return detailValue(value);
      if (RUN_STATUS_VALUES.includes(value)) return testingRunStatusLabel(value as TestingRunStatus, language);
      if (REVIEW_STATUS_VALUES.includes(value)) {
        return testingReviewStatusLabel(value as TestingReviewStatus, language);
      }
      return testingAssignmentStatusLabel(value, language);
    case "role":
      return typeof value === "string" ? adminRoleLabel(value as AuthUser["role"], language) : detailValue(value);
    case "severity":
      return typeof value === "string"
        ? testingReviewSeverityLabel(value as TestingReviewSeverity, language)
        : detailValue(value);
    case "runId": {
      const run = typeof value === "string" ? lookup.runs.get(value) : undefined;
      return run ? run.name : localized(language, "发布运行未加载", "Release run not loaded");
    }
    case "sessionId": {
      const session = typeof value === "string" ? lookup.sessions.get(value) : undefined;
      return session ? sessionLabel(session) : localized(language, "会话未加载", "Session not loaded");
    }
    case "scope":
      return scopeLabel(value, lookup, language);
    case "requirementId": {
      const runId = typeof detail.runId === "string" ? detail.runId : null;
      const run = runId ? lookup.runs.get(runId) : undefined;
      const requirement = run?.requirements.find((candidate) => candidate.id === value);
      return requirement
        ? `${findTestingTestCase(requirement.testCaseId).name} · ${labelPair(
            PLATFORM_LABELS[requirement.platform],
            language,
            requirement.platform
          )}`
        : localized(language, "覆盖要求未加载", "Coverage requirement not loaded");
    }
    default:
      return detailValue(value);
  }
}

type PolicyDiffRow = { path: string; from: string; to: string; changed?: boolean };
function thresholdValue(policy: TestingPolicy, field: PolicyThresholdField) {
  return field.group === "release" ? policy.release[field.key] : policy.regression[field.key];
}

function policyDiffRows(before: TestingPolicy, after: TestingPolicy): PolicyDiffRow[] {
  const rows: PolicyDiffRow[] = [];
  for (const field of POLICY_THRESHOLD_FIELDS) {
    const from = thresholdValue(before, field);
    const to = thresholdValue(after, field);
    if (from !== to) {
      rows.push({ path: `${field.group}.${String(field.key)}`, from: String(from), to: String(to) });
    }
  }
  const fromPlatforms = [...before.release.requiredPlatforms].sort().join(", ") || "—";
  const toPlatforms = [...after.release.requiredPlatforms].sort().join(", ") || "—";
  if (fromPlatforms !== toPlatforms) {
    rows.push({ path: "release.requiredPlatforms", from: fromPlatforms, to: toPlatforms });
  }
  if (before.description !== after.description) {
    rows.push({ path: "description", from: before.description, to: after.description });
  }
  return rows;
}

function policyCompareRows(selected: TestingPolicy, active: TestingPolicy): PolicyDiffRow[] {
  const rows: PolicyDiffRow[] = POLICY_THRESHOLD_FIELDS.map((field) => {
    const from = thresholdValue(selected, field);
    const to = thresholdValue(active, field);
    return {
      path: `${field.group}.${String(field.key)}`,
      from: String(from),
      to: String(to),
      changed: from !== to
    };
  });
  const fromPlatforms = [...selected.release.requiredPlatforms].sort().join(", ") || "—";
  const toPlatforms = [...active.release.requiredPlatforms].sort().join(", ") || "—";
  rows.push({
    path: "release.requiredPlatforms",
    from: fromPlatforms,
    to: toPlatforms,
    changed: fromPlatforms !== toPlatforms
  });
  rows.push({
    path: "description",
    from: selected.description,
    to: active.description,
    changed: selected.description !== active.description
  });
  return rows;
}

/** Mirrors the relay's bounds so invalid drafts never reach the server. */
function policyDraftErrors(draft: TestingPolicy | null, language: Language): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!draft) return errors;
  for (const field of POLICY_THRESHOLD_FIELDS) {
    const value = thresholdValue(draft, field);
    const path = `${field.group}.${String(field.key)}`;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      errors[path] = localized(language, "请输入有效数字", "Enter a valid number");
      continue;
    }
    if (!Number.isInteger(value)) {
      errors[path] = localized(language, "请输入整数", "Enter a whole number");
      continue;
    }
    if (value < field.min || value > field.max) {
      errors[path] = localized(
        language,
        `需在 ${field.min}–${field.max} 之间`,
        `Must be between ${field.min} and ${field.max}`
      );
    }
  }
  if (!draft.release.requiredPlatforms.length) {
    errors["release.requiredPlatforms"] = localized(language, "至少选择一个平台", "Select at least one platform");
  }
  if (draft.regression.latencyFailDeltaMs < draft.regression.latencyWatchDeltaMs) {
    errors["regression.latencyFailDeltaMs"] = localized(
      language,
      "失败阈值不能低于观察阈值",
      "Fail delta cannot be below the watch delta"
    );
  }
  if (draft.regression.scoreFailDelta > draft.regression.scoreWatchDelta) {
    errors["regression.scoreFailDelta"] = localized(
      language,
      "失败降幅不能高于观察降幅",
      "Fail delta cannot exceed the watch delta"
    );
  }
  return errors;
}

function dateFilterBound(date: string, endOfDay: boolean): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const ms = new Date(`${date}T${endOfDay ? "23:59:59.999" : "00:00:00"}`).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** Initial params are only adopted from the exact section this view owns, so
 * a wrong-view or hidden instance never steals another section's URL state. */
function initialViewParams(view: GovernanceView): URLSearchParams {
  const initial = readWorkspaceLocation();
  const ownsSection =
    view === "policy"
      ? initial.isTesting && initial.section === "policies"
      : initial.isAdmin && initial.section === "audit";
  return ownsSection ? initial.params : new URLSearchParams();
}

function PolicyDiffTable({ rows, language }: { rows: PolicyDiffRow[]; language: Language }) {
  return (
    <dl className="policyDiffTable">
      {rows.map((row) => (
        <div key={row.path} className={`policyDiffRow${row.changed ? " changed" : ""}`}>
          <dt>{labelPair(POLICY_FIELD_LABELS[row.path], language, row.path)}</dt>
          <dd>
            <span className="policyDiffFrom">{row.from}</span>
            <span aria-hidden="true">→</span>
            <span className="policyDiffTo">{row.to}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** One persistent instance per responsibility: Testing/policies owns the
 * policy workbench; Administration/audit owns the read-only audit trail. The
 * parent keeps both mounted and hides the inactive one, so each view guards
 * every URL read and write against its own exact section. */
export function GovernanceWorkspace({ view, user, data }: Props) {
  if (view === "audit") return <AuditTrailView user={user} data={data} />;
  return <PolicyWorkbenchView user={user} data={data} />;
}

function PolicyWorkbenchView({ user, data }: Omit<Props, "view">) {
  const { language } = useLanguage();
  const location = useWorkspaceLocation();
  const onPolicySection = location.isTesting && location.section === "policies";

  const [policyViewVersion, setPolicyViewVersion] = useState<string | null>(() =>
    initialViewParams("policy").get("policy")
  );
  const [notice, setNotice] = useState<Notice | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const activePolicy = data.operations?.activePolicy ?? null;
  const isAdmin = user.role === "admin";
  const [draft, setDraft] = useState<TestingPolicy | null>(activePolicy ? { ...activePolicy, description: "" } : null);
  const [draftBase, setDraftBase] = useState<TestingPolicy | null>(
    activePolicy ? { ...activePolicy, description: "" } : null
  );

  const draftErrors = useMemo(() => policyDraftErrors(draft, language), [draft, language]);
  const draftDirty = useMemo(
    () => (draftBase && draft ? policyDiffRows(draftBase, draft).length > 0 : false),
    [draftBase, draft]
  );
  const draftOutdated = !!activePolicy && !!draftBase && activePolicy.version !== draftBase.version;

  useEffect(() => {
    if (!activePolicy || activePolicy.version === draftBase?.version) return;
    if (draftDirty) {
      setReviewOpen(false);
      return;
    }
    const next = { ...activePolicy, description: "" };
    setDraftBase(next);
    setDraft(next);
    setReviewOpen(false);
  }, [activePolicy, draftBase?.version, draftDirty]);

  useEffect(() => {
    if (!draftDirty || typeof window === "undefined" || !window.addEventListener || !window.removeEventListener) {
      return;
    }
    const guard = (event: Event) => event.preventDefault();
    const guardExit = (event: Event) => {
      if (
        !event.defaultPrevented &&
        !window.confirm(
          localized(
            language,
            "放弃未保存的策略草稿并离开工作区？",
            "Discard your unsaved policy draft and leave the workspace?"
          )
        )
      )
        event.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    window.addEventListener("admin:beforeleave", guardExit);
    return () => {
      window.removeEventListener("beforeunload", guard);
      window.removeEventListener("admin:beforeleave", guardExit);
    };
  }, [draftDirty, language]);

  // URL is the source of truth while the policies section is visible; the
  // component stays mounted when hidden, so hydration ignores other sections.
  const policyQuery = onPolicySection ? location.params.toString() : null;
  useEffect(() => {
    if (policyQuery === null) return;
    const nextPolicy = new URLSearchParams(policyQuery).get("policy");
    setPolicyViewVersion((current) => (current === nextPolicy ? current : nextPolicy));
  }, [policyQuery]);

  // Hidden sections must never rewrite the visible route.
  const writePolicyParams = (updates: Record<string, string | null>, replace = true) => {
    if (!(location.isTesting && location.section === "policies")) return;
    setWorkspaceLocation("policies", updates, replace);
  };

  const selectPolicyVersion = (version: string | null) => {
    setPolicyViewVersion(version);
    writePolicyParams({ policy: version && version !== activePolicy?.version ? version : null }, false);
  };

  const updateDraftThreshold = (field: PolicyThresholdField, raw: string) => {
    setDraft((current) => {
      if (!current) return current;
      if (field.group === "release") {
        return { ...current, release: { ...current.release, [field.key]: raw.trim() === "" ? NaN : Number(raw) } };
      }
      return { ...current, regression: { ...current.regression, [field.key]: raw.trim() === "" ? NaN : Number(raw) } };
    });
  };

  const toggleDraftPlatform = (platform: TestingPlatform) => {
    setDraft((current) => {
      if (!current) return current;
      const selected = new Set(current.release.requiredPlatforms);
      if (selected.has(platform)) selected.delete(platform);
      else selected.add(platform);
      return { ...current, release: { ...current.release, requiredPlatforms: [...selected] } };
    });
  };

  const updateDraftDescription = (raw: string) => {
    setDraft((current) => (current ? { ...current, description: raw } : current));
  };

  const draftValid = Object.keys(draftErrors).length === 0;
  const canRequestReview =
    isAdmin &&
    draftValid &&
    Boolean(draft?.description.trim()) &&
    !publishing &&
    !draftOutdated &&
    data.status === "ready";

  const publishPolicy = async () => {
    if (!activePolicy || !draft || !canRequestReview || !reviewOpen) return;
    setPublishing(true);
    setNotice(null);
    const result = await data.createPolicy({
      ...draft,
      version: `${new Date().toISOString().slice(0, 10)}.${Date.now()}`,
      description: draft.description.trim(),
      active: true
    });
    if (result.ok) {
      setReviewOpen(false);
      const cleanDraft = { ...draft, description: "" };
      setDraftBase(cleanDraft);
      setDraft(cleanDraft);
      setNotice({
        tone: "success",
        message: localized(
          language,
          `策略 ${result.data.version} 已发布并写入审计日志。`,
          `Policy ${result.data.version} published and recorded in the audit log.`
        )
      });
      await data.refresh();
    } else {
      setNotice({ tone: "error", message: result.error.message });
    }
    setPublishing(false);
  };

  const historyPolicies = useMemo(() => [...data.policies].sort((a, b) => b.createdAt - a.createdAt), [data.policies]);
  const selectedPolicy = useMemo(() => {
    if (!activePolicy) return null;
    return historyPolicies.find((entry) => entry.version === policyViewVersion) ?? activePolicy;
  }, [activePolicy, historyPolicies, policyViewVersion]);
  const publishDiff = activePolicy && draft ? policyDiffRows(activePolicy, draft) : [];

  return (
    <section
      className="testingControlPlane adminSectionCard"
      aria-label={localized(language, "发布策略", "Publish policy")}
    >
      <div className="controlPlaneHead adminSectionHeader">
        <div>
          <span>MAX QA · {localized(language, "策略", "Policy")}</span>
          <strong>{localized(language, "发布策略", "Publish policy")}</strong>
        </div>
      </div>

      {notice ? (
        <p className={`adminNotice ${notice.tone}`} role="status">
          {notice.message}
        </p>
      ) : null}

      {!activePolicy ? (
        <p className="adminWorkspaceLoading">
          {data.status === "loading"
            ? localized(language, "正在加载策略数据…", "Loading policy data…")
            : localized(language, "暂无可用策略数据。", "No policy data available.")}
        </p>
      ) : null}

      {activePolicy && draft ? (
        <div className="policyWorkbench">
          <div className="activePolicyCard">
            <span>{localized(language, "当前生效策略", "Active policy")}</span>
            <strong>{activePolicy.version}</strong>
            <p>{activePolicy.description}</p>
            <small>
              {localized(language, "已批准基线：", "Approved baseline: ")}
              {data.operations?.approvedBaselineBuild ?? localized(language, "尚未选择", "Not selected")}
            </small>
            <small>
              {activePolicy.createdBy} · {formatAbsoluteTime(activePolicy.createdAt, language)} ·{" "}
              {formatAdminRelativeTime(activePolicy.createdAt, language)}
            </small>
          </div>

          <div className="policyEditor">
            {draftOutdated ? (
              <div className="adminNotice" role="status">
                <strong>
                  {localized(
                    language,
                    "生效策略已更新，草稿已保留。",
                    "The active policy changed. Your draft has been preserved."
                  )}
                </strong>
                <p>
                  {localized(
                    language,
                    "请查看最新版本，并在重新编辑后发布。",
                    "Inspect the latest version before preparing a new publication."
                  )}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    if (
                      draftDirty &&
                      !window.confirm(
                        localized(
                          language,
                          "放弃当前草稿并载入最新策略？",
                          "Discard this draft and load the latest policy?"
                        )
                      )
                    )
                      return;
                    const next = { ...activePolicy, description: "" };
                    setDraftBase(next);
                    setDraft(next);
                    setReviewOpen(false);
                  }}
                >
                  {localized(language, "载入最新策略", "Load latest policy")}
                </button>
              </div>
            ) : null}
            <h4 className="policyGroupHead">{localized(language, "发布门槛", "Release thresholds")}</h4>
            <div className="policyFieldGrid">
              {RELEASE_THRESHOLD_FIELDS.map((field) => {
                const path = `release.${String(field.key)}`;
                return (
                  <label key={path} className="policyField">
                    <span>{labelPair(POLICY_FIELD_LABELS[path], language, path)}</span>
                    <input
                      type="number"
                      min={field.min}
                      max={field.max}
                      step={1}
                      aria-label={labelPair(POLICY_FIELD_LABELS[path], language, path)}
                      value={Number.isFinite(draft.release[field.key]) ? String(draft.release[field.key]) : ""}
                      onChange={(event) => updateDraftThreshold(field, event.target.value)}
                      disabled={!isAdmin || publishing || reviewOpen}
                    />
                    {draftErrors[path] ? <em className="policyFieldError">{draftErrors[path]}</em> : null}
                  </label>
                );
              })}
            </div>

            <h4 className="policyGroupHead">{localized(language, "回归门槛", "Regression thresholds")}</h4>
            <div className="policyFieldGrid">
              {REGRESSION_THRESHOLD_FIELDS.map((field) => {
                const path = `regression.${String(field.key)}`;
                return (
                  <label key={path} className="policyField">
                    <span>{labelPair(POLICY_FIELD_LABELS[path], language, path)}</span>
                    <input
                      type="number"
                      min={field.min}
                      max={field.max}
                      step={1}
                      aria-label={labelPair(POLICY_FIELD_LABELS[path], language, path)}
                      value={Number.isFinite(draft.regression[field.key]) ? String(draft.regression[field.key]) : ""}
                      onChange={(event) => updateDraftThreshold(field, event.target.value)}
                      disabled={!isAdmin || publishing || reviewOpen}
                    />
                    {draftErrors[path] ? <em className="policyFieldError">{draftErrors[path]}</em> : null}
                  </label>
                );
              })}
            </div>

            <fieldset className="policyPlatformPicker">
              <legend>
                {labelPair(POLICY_FIELD_LABELS["release.requiredPlatforms"], language, "release.requiredPlatforms")}
              </legend>
              {POLICY_PICKER_PLATFORMS.map((platform) => (
                <label key={platform}>
                  <input
                    type="checkbox"
                    checked={draft.release.requiredPlatforms.includes(platform)}
                    onChange={() => toggleDraftPlatform(platform)}
                    disabled={!isAdmin || publishing || reviewOpen}
                  />
                  <span>{labelPair(PLATFORM_LABELS[platform], language, platform)}</span>
                </label>
              ))}
              {draftErrors["release.requiredPlatforms"] ? (
                <em className="policyFieldError">{draftErrors["release.requiredPlatforms"]}</em>
              ) : null}
            </fieldset>

            <label className="policyRationale">
              <span>{localized(language, "变更理由", "Change reason")}</span>
              <textarea
                value={draft.description}
                onChange={(event) => updateDraftDescription(event.target.value)}
                disabled={!isAdmin || publishing || reviewOpen}
                placeholder={localized(
                  language,
                  "说明门槛调整及发布依据…",
                  "Explain threshold changes and release basis…"
                )}
              />
            </label>

            {isAdmin ? (
              reviewOpen ? (
                <div className="policyReviewPanel">
                  <h4 className="policyGroupHead">{localized(language, "确认发布", "Review publication")}</h4>
                  <p className="policyReviewNote">
                    {localized(
                      language,
                      "版本号将在发布时生成（日期 + 时间戳）。",
                      "A version id is generated on publish (date + timestamp)."
                    )}
                  </p>
                  {publishDiff.length ? (
                    <PolicyDiffTable rows={publishDiff} language={language} />
                  ) : (
                    <p className="policyReviewNote">
                      {localized(
                        language,
                        "门槛与当前生效策略一致，将仅更新描述。",
                        "Thresholds match the active policy; only the description changes."
                      )}
                    </p>
                  )}
                  <p className="policyReviewRationale">“{draft.description.trim()}”</p>
                  <div className="policyActions">
                    <button
                      type="button"
                      className="primary"
                      disabled={!canRequestReview}
                      onClick={() => void publishPolicy()}
                    >
                      {publishing
                        ? localized(language, "正在发布…", "Publishing…")
                        : localized(language, "确认发布", "Confirm publish")}
                    </button>
                    <button type="button" disabled={publishing} onClick={() => setReviewOpen(false)}>
                      {localized(language, "继续编辑", "Keep editing")}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="policyActions">
                  <button
                    type="button"
                    className="primary"
                    disabled={!canRequestReview}
                    onClick={() => setReviewOpen(true)}
                  >
                    {localized(language, "检查并发布", "Review & publish")}
                  </button>
                </div>
              )
            ) : (
              <p className="policyReviewNote">
                {localized(
                  language,
                  "审核员拥有只读权限；策略变更与发布仅限管理员。",
                  "Reviewers are read-only; policy changes and publishing are limited to administrators."
                )}
              </p>
            )}
          </div>

          {selectedPolicy ? (
            <div className="policyHistory">
              <label className="policyVersionSelect">
                <span>{localized(language, "历史版本", "History")}</span>
                <select
                  value={selectedPolicy.version}
                  aria-label={localized(language, "历史版本", "History")}
                  onChange={(event) => selectPolicyVersion(event.target.value)}
                >
                  {historyPolicies.map((entry) => (
                    <option key={entry.version} value={entry.version}>
                      {entry.version}
                      {entry.active ? localized(language, "（生效中）", " (active)") : ""}
                    </option>
                  ))}
                </select>
              </label>
              <small className="policyHistoryMeta">
                {selectedPolicy.createdBy} · {formatAbsoluteTime(selectedPolicy.createdAt, language)} ·{" "}
                {formatAdminRelativeTime(selectedPolicy.createdAt, language)}
              </small>
              <p className="policyHistoryMeta">
                {selectedPolicy.version === activePolicy.version
                  ? localized(language, "正在查看当前生效版本。", "You are viewing the active version.")
                  : localized(
                      language,
                      `与当前生效版本 ${activePolicy.version} 对比：`,
                      `Compared with the active version ${activePolicy.version}:`
                    )}
              </p>
              <PolicyDiffTable rows={policyCompareRows(selectedPolicy, activePolicy)} language={language} />
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function AuditTrailView({ user, data }: Omit<Props, "view">) {
  const { language } = useLanguage();
  const location = useWorkspaceLocation();
  const isAdmin = user.role === "admin";
  const onAuditSection = location.isAdmin && location.section === "audit";

  const [auditEventId, setAuditEventId] = useState<string | null>(() => initialViewParams("audit").get("audit"));
  const [filters, setFilters] = useState<AuditFilters>(() => {
    const params = initialViewParams("audit");
    return {
      search: params.get("search") ?? "",
      actor: params.get("actor") ?? "",
      action: params.get("action") ?? "all",
      from: params.get("from") ?? "",
      to: params.get("to") ?? ""
    };
  });

  const lookup = useMemo(() => buildAuditLookup(data), [data]);
  const audit = useMemo(() => data.operations?.audit ?? [], [data.operations?.audit]);
  const availableActions = useMemo(() => [...new Set(audit.map((event) => event.action))].sort(), [audit]);

  const filteredAudit = useMemo(() => {
    const actorNeedle = filters.actor.trim().toLowerCase();
    const searchNeedle = filters.search.trim().toLowerCase();
    const fromMs = dateFilterBound(filters.from, false);
    const toMs = dateFilterBound(filters.to, true);
    return audit.filter((event) => {
      if (filters.action !== "all" && event.action !== filters.action) return false;
      if (actorNeedle && !event.actor.toLowerCase().includes(actorNeedle)) return false;
      if (fromMs !== null && event.at < fromMs) return false;
      if (toMs !== null && event.at > toMs) return false;
      if (searchNeedle) {
        const target = auditTargetDisplay(event, lookup, language);
        const haystack = [
          labelPair(AUDIT_ACTION_LABELS[event.action], language, event.action),
          event.action,
          event.actor,
          target.text,
          event.targetId
        ]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(searchNeedle)) return false;
      }
      return true;
    });
  }, [audit, filters, language, lookup]);

  const filtersActive =
    filters.search.trim() !== "" ||
    filters.actor.trim() !== "" ||
    filters.action !== "all" ||
    filters.from !== "" ||
    filters.to !== "";

  // URL is the source of truth while the audit section is visible; the
  // component stays mounted when hidden, so hydration ignores other sections.
  const auditQuery = onAuditSection ? location.params.toString() : null;
  useEffect(() => {
    if (auditQuery === null) return;
    const params = new URLSearchParams(auditQuery);
    const nextAudit = params.get("audit");
    setAuditEventId((current) => (current === nextAudit ? current : nextAudit));
    setFilters((current) => {
      const next: AuditFilters = {
        search: params.get("search") ?? "",
        actor: params.get("actor") ?? "",
        action: params.get("action") ?? "all",
        from: params.get("from") ?? "",
        to: params.get("to") ?? ""
      };
      return current.search === next.search &&
        current.actor === next.actor &&
        current.action === next.action &&
        current.from === next.from &&
        current.to === next.to
        ? current
        : next;
    });
  }, [auditQuery]);

  // Hidden sections must never rewrite the visible route.
  const writeAuditParams = (updates: Record<string, string | null>, replace = true) => {
    if (!(location.isAdmin && location.section === "audit")) return;
    setWorkspaceLocation("audit", updates, replace);
  };

  const updateFilter = (key: keyof AuditFilters, value: string) => {
    setFilters((current) => ({ ...current, [key]: value }));
    writeAuditParams({ [key]: value === "" || (key === "action" && value === "all") ? null : value });
  };

  const clearAuditFilters = () => {
    setFilters(EMPTY_AUDIT_FILTERS);
    writeAuditParams({ search: null, actor: null, action: null, from: null, to: null });
  };

  const toggleAuditDetail = (eventId: string) => {
    const next = auditEventId === eventId ? null : eventId;
    setAuditEventId(next);
    writeAuditParams({ audit: next });
  };

  return (
    <section className="testingControlPlane adminSectionCard" aria-label={localized(language, "审计日志", "Audit log")}>
      <div className="controlPlaneHead adminSectionHeader">
        <div>
          <span>MAX ADMIN · {localized(language, "审计", "Audit")}</span>
          <strong>{localized(language, "审计日志", "Audit log")}</strong>
        </div>
      </div>

      {/* The parent mounts this view only for administrators; the leaf still
       * fails closed so a reviewer can never reach the audit history. */}
      {!isAdmin ? (
        <p className="adminWorkspaceLoading">
          {localized(language, "系统审计日志仅限管理员查看。", "The system audit log is restricted to administrators.")}
        </p>
      ) : (
        <div className="auditTimeline">
          <div className="governanceFilterBar">
            <label className="governanceFilterField">
              <span>{localized(language, "搜索", "Search")}</span>
              <input
                value={filters.search}
                onChange={(event) => updateFilter("search", event.target.value)}
                placeholder={localized(language, "操作、对象或操作人", "Action, target, or actor")}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className="governanceFilterField">
              <span>{localized(language, "操作类型", "Action type")}</span>
              <select value={filters.action} onChange={(event) => updateFilter("action", event.target.value)}>
                <option value="all">{localized(language, "全部操作", "All actions")}</option>
                {availableActions.map((action) => (
                  <option key={action} value={action}>
                    {labelPair(AUDIT_ACTION_LABELS[action], language, action)}
                  </option>
                ))}
              </select>
            </label>
            <label className="governanceFilterField">
              <span>{localized(language, "操作人", "Actor")}</span>
              <input
                value={filters.actor}
                onChange={(event) => updateFilter("actor", event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className="governanceFilterField">
              <span>{localized(language, "开始日期", "From date")}</span>
              <input
                type="date"
                value={filters.from}
                onChange={(event) => updateFilter("from", event.target.value)}
                autoComplete="off"
              />
            </label>
            <label className="governanceFilterField">
              <span>{localized(language, "结束日期", "To date")}</span>
              <input
                type="date"
                value={filters.to}
                onChange={(event) => updateFilter("to", event.target.value)}
                autoComplete="off"
              />
            </label>
            {filtersActive ? (
              <button type="button" className="governanceFilterClear" onClick={clearAuditFilters}>
                {localized(language, "清除筛选", "Clear filters")}
              </button>
            ) : null}
          </div>
          <p className="governanceFilterCount">
            {localized(
              language,
              `显示 ${filteredAudit.length} / ${audit.length} 条记录`,
              `Showing ${filteredAudit.length} of ${audit.length} events`
            )}
          </p>

          {filteredAudit.map((event) => {
            const target = auditTargetDisplay(event, lookup, language);
            const detailEntries = Object.entries(event.detail);
            return (
              <article key={event.id} className="auditEvent">
                <div className="auditEventHead">
                  <strong>{labelPair(AUDIT_ACTION_LABELS[event.action], language, event.action)}</strong>
                  <time dateTime={new Date(event.at).toISOString()}>
                    {formatAbsoluteTime(event.at, language)} · {formatAdminRelativeTime(event.at, language)}
                  </time>
                </div>
                <p className="auditEventMeta">
                  <span>
                    {localized(language, "操作人", "Actor")}: {event.actor}
                  </span>
                  <span>
                    {labelPair(AUDIT_TARGET_TYPE_LABELS[event.targetType], language, event.targetType)}:{" "}
                    {target.href ? (
                      <a href={target.href}>{target.text}</a>
                    ) : (
                      <span className="auditTargetMissing">{target.text}</span>
                    )}
                  </span>
                </p>
                {detailEntries.length ? (
                  <dl className="auditEventDetail">
                    {detailEntries.map(([key, value]) => (
                      <div key={key}>
                        <dt>{labelPair(AUDIT_DETAIL_LABELS[key], language, key)}</dt>
                        <dd>{formatAuditValue(key, value, event.detail, lookup, language)}</dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <p className="auditEventDetail">{localized(language, "暂无额外详情", "No additional detail")}</p>
                )}
                <button
                  type="button"
                  className="auditRawToggle"
                  aria-expanded={auditEventId === event.id}
                  onClick={() => toggleAuditDetail(event.id)}
                >
                  {localized(language, "技术详情", "Technical details")}
                </button>
                {auditEventId === event.id ? (
                  <pre className="auditRaw">
                    {JSON.stringify(
                      {
                        id: event.id,
                        at: event.at,
                        actor: event.actor,
                        action: event.action,
                        targetType: event.targetType,
                        targetId: event.targetId,
                        detail: event.detail
                      },
                      null,
                      2
                    )}
                  </pre>
                ) : null}
              </article>
            );
          })}

          {!audit.length ? (
            <p className="testerConversationEmpty">
              {localized(language, "尚未记录系统或质量变更。", "No system or quality changes recorded.")}
            </p>
          ) : null}
          {audit.length && !filteredAudit.length ? (
            <div className="testerConversationEmpty">
              <p>{localized(language, "没有匹配筛选条件的审计记录。", "No audit events match the current filters.")}</p>
              {filtersActive ? (
                <button type="button" className="governanceFilterClear" onClick={clearAuditFilters}>
                  {localized(language, "清除筛选", "Clear filters")}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
