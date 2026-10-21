import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  TESTING_TEST_CASES,
  testingBuildsMatch,
  type TestingAssignment,
  type TestingRun,
  type TestingRunRequirement,
  type TestingRunStatus
} from "../../../shared/testing";
import type { HelmetAgent } from "../../hooks/useHelmetAgent";
import { useLanguage } from "../LanguageToggle";
import { localized } from "../../lib/i18n";
import type { AuthUser } from "../../lib/auth";
import {
  formatAdminRelativeTime,
  releaseApprovalBlockers,
  testingAssignmentStatusLabel,
  testingRunStatusLabel
} from "./admin-model";
import { readWorkspaceLocation, setWorkspaceLocation, useWorkspaceLocation } from "./workspace-location";
import type { AdminTestingData } from "./useAdminTestingData";

type BusyTarget =
  | { kind: "create-run" }
  | { kind: "run-status"; id: string }
  | { kind: "assignment"; runId: string; requirementId: string }
  | null;

type Notice = { tone: "success" | "error"; message: string; englishMessage?: string };
type MutationRequest = { key: string; requestId: number };

type Props = {
  agent: HelmetAgent;
  user: AuthUser;
  data: AdminTestingData;
};

/** Approval is a dedicated two-step action; the generic status select never offers it. */
const RUN_STATUSES: TestingRunStatus[] = ["draft", "active", "blocked", "ready", "approved", "archived"];

type CoverageRow = {
  requirement: TestingRunRequirement;
  assignments: TestingAssignment[];
  completed: number;
  complete: boolean;
};

type CoverageGroup = { testCaseId: string; name: string; rows: CoverageRow[] };

type ApprovalDraft = { runId: string; build: string; status: TestingRunStatus };

function runProgress(run: TestingRun) {
  let required = 0;
  let completed = 0;
  for (const requirement of run.requirements) {
    required += requirement.requiredValidSessions;
    let captured = 0;
    for (const assignment of run.assignments) {
      if (assignment.requirementId === requirement.id) captured += assignment.completedSessionIds.length;
    }
    completed += Math.min(requirement.requiredValidSessions, captured);
  }
  return { required, completed, percent: required ? Math.round((completed / required) * 100) : 0 };
}

/** Groups the flat requirement list into a per-test-case checklist so web/ios/android
 * rows read as one guided workflow instead of an endless card grid. */
function coverageGroups(run: TestingRun): CoverageGroup[] {
  const groups: CoverageGroup[] = [];
  for (const requirement of run.requirements) {
    const assignments = run.assignments.filter((item) => item.requirementId === requirement.id);
    const completed = assignments.reduce((sum, item) => sum + item.completedSessionIds.length, 0);
    let group = groups.find((item) => item.testCaseId === requirement.testCaseId);
    if (!group) {
      group = {
        testCaseId: requirement.testCaseId,
        name: TESTING_TEST_CASES.find((item) => item.id === requirement.testCaseId)?.name ?? requirement.testCaseId,
        rows: []
      };
      groups.push(group);
    }
    group.rows.push({
      requirement,
      assignments,
      completed,
      complete: completed >= requirement.requiredValidSessions
    });
  }
  return groups;
}

function dueDateLabel(dueAt: number | undefined) {
  if (!dueAt) return "";
  const date = new Date(dueAt);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function busyTargetKey(target: Exclude<BusyTarget, null>) {
  if (target.kind === "create-run") return "create-run";
  if (target.kind === "run-status") return `run-status:${target.id}`;
  return `assignment:${target.runId}:${target.requirementId}`;
}

export function ReleaseValidation({ agent, user, data }: Props) {
  const { language } = useLanguage();
  const { section, params, navigate } = useWorkspaceLocation();
  const isReviewer = user.role === "admin" || user.role === "reviewer";
  const isAdmin = user.role === "admin";
  const currentBuild = agent.health?.build?.gitCommit ?? "local";
  const runs = useMemo(
    () => (isReviewer ? (data.operations?.runs ?? []) : data.runs),
    [isReviewer, data.operations?.runs, data.runs]
  );
  const [rememberedRunId, setRememberedRunId] = useState<string | null>(null);
  const [busyTargets, setBusyTargets] = useState<ReadonlySet<string>>(() => new Set());
  const [notice, setNotice] = useState<Notice | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [runName, setRunName] = useState("");
  const [runBuild, setRunBuild] = useState(currentBuild);
  const [runOwner, setRunOwner] = useState(user.username);
  const [runDueDate, setRunDueDate] = useState("");
  const [assignee, setAssignee] = useState(user.username);
  const [approval, setApproval] = useState<ApprovalDraft | null>(null);
  const mutationSequenceRef = useRef(0);
  const targetRequestRef = useRef(new Map<string, number>());
  const noticeRequestRef = useRef(0);
  const lastLocationRef = useRef<{ section: string; runId: string | null }>({ section: "", runId: null });
  const approvalDialogRef = useRef<HTMLDivElement>(null);
  const navigationVersionRef = useRef(0);
  const mountedRef = useRef(true);
  // The URL owns the selection while this section is active; the remembered id keeps
  // it across section switches because every admin section stays mounted.
  const urlRunId = section === "releases" ? params.get("run") : null;
  const selectedRun = urlRunId
    ? runs.find((run) => run.id === urlRunId)
    : (runs.find((run) => run.id === rememberedRunId) ?? runs[0]);
  const createDraftDirty =
    isReviewer &&
    (runName.trim() !== "" ||
      runBuild.trim() !== currentBuild ||
      runOwner.trim() !== user.username ||
      runDueDate !== "");
  const dialogRun = approval ? (runs.find((run) => run.id === approval.runId) ?? null) : null;

  const blockersFor = (run: TestingRun) => {
    const blockers = releaseApprovalBlockers(
      run,
      data.testing,
      data.operations?.reviews,
      language,
      agent.health?.build?.gitCommit
    );
    if (data.status !== "ready")
      blockers.unshift(localized(language, "发布数据尚未同步。", "Release data is not current."));
    return blockers;
  };

  const approvalBlockers = selectedRun ? blockersFor(selectedRun) : [];
  const dialogBlockers = dialogRun ? blockersFor(dialogRun) : [];

  useEffect(() => setRunBuild(currentBuild), [currentBuild]);

  // Keep the remembered selection aligned with the URL: an explicit run param
  // becomes the memory that survives section switches, while going Back inside
  // this section to a param-less URL releases it back to the default run.
  useEffect(() => {
    mountedRef.current = true;
    const onNavigate = () => {
      navigationVersionRef.current += 1;
    };
    window.addEventListener?.("hashchange", onNavigate);
    window.addEventListener?.("popstate", onNavigate);
    return () => {
      mountedRef.current = false;
      navigationVersionRef.current += 1;
      window.removeEventListener?.("hashchange", onNavigate);
      window.removeEventListener?.("popstate", onNavigate);
    };
  }, []);

  useEffect(() => {
    const runId = urlRunId;
    const previous = lastLocationRef.current;
    lastLocationRef.current = { section, runId };
    if (section !== "releases") return;
    if (runId) setRememberedRunId(runId);
    else if (previous.section === "releases" && previous.runId) setRememberedRunId(null);
    else if (previous.section !== "releases" && rememberedRunId && runs.some((run) => run.id === rememberedRunId)) {
      navigate("releases", { run: rememberedRunId }, true);
    }
  }, [section, urlRunId, rememberedRunId, runs, navigate]);

  useEffect(() => {
    if (!createDraftDirty || typeof window === "undefined" || !window.addEventListener) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    const guardExit = (event: Event) => {
      if (
        !event.defaultPrevented &&
        !window.confirm(
          localized(
            language,
            "放弃未保存的发布草稿并离开工作区？",
            "Discard your unsaved release draft and leave the workspace?"
          )
        )
      ) {
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", guard);
    window.addEventListener("admin:beforeleave", guardExit);
    return () => {
      window.removeEventListener("beforeunload", guard);
      window.removeEventListener("admin:beforeleave", guardExit);
    };
  }, [createDraftDirty, language]);

  useEffect(() => {
    if (section !== "releases") setApproval(null);
  }, [section]);

  useEffect(() => {
    if (!approval || typeof document === "undefined") return;
    const dialog = approvalDialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.querySelector<HTMLElement>("button")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setApproval(null);
      } else if (event.key === "Tab") {
        const controls = dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]'
        );
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    dialog.addEventListener("keydown", onKeyDown);
    return () => {
      dialog.removeEventListener("keydown", onKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [approval]);

  const beginMutation = (target: Exclude<BusyTarget, null>): MutationRequest => {
    const key = busyTargetKey(target);
    const requestId = ++mutationSequenceRef.current;
    targetRequestRef.current.set(key, requestId);
    noticeRequestRef.current = requestId;
    setBusyTargets((current) => new Set(current).add(key));
    setNotice(null);
    return { key, requestId };
  };

  const ownsMutation = ({ key, requestId }: MutationRequest) => targetRequestRef.current.get(key) === requestId;

  const setOwnedNotice = (request: MutationRequest, nextNotice: Notice) => {
    if (noticeRequestRef.current === request.requestId) setNotice(nextNotice);
  };

  const finishMutation = (request: MutationRequest) => {
    if (!ownsMutation(request)) return;
    targetRequestRef.current.delete(request.key);
    setBusyTargets((current) => {
      if (!current.has(request.key)) return current;
      const next = new Set(current);
      next.delete(request.key);
      return next;
    });
  };

  const setTransientNotice = (nextNotice: Notice) => {
    noticeRequestRef.current = ++mutationSequenceRef.current;
    setNotice(nextNotice);
  };

  const writeRunParam = (runId: string, replace: boolean) => {
    const location = readWorkspaceLocation();
    // Async completions can fire while another section is active; never hijack its URL.
    if (!location.isAdmin || location.section !== "releases") return;
    setWorkspaceLocation("releases", { run: runId }, replace);
  };

  const selectRun = (runId: string) => {
    setRememberedRunId(runId);
    writeRunParam(runId, false);
  };

  const createRun = async () => {
    const request = beginMutation({ kind: "create-run" });
    const navigationVersion = navigationVersionRef.current;
    try {
      const result = await data.createRun({
        name: runName.trim() || localized(language, `发布 ${runBuild}`, `Release ${runBuild}`),
        build: runBuild.trim() || currentBuild,
        owner: runOwner.trim() || user.username,
        dueAt: runDueDate ? new Date(`${runDueDate}T23:59:59`).getTime() : undefined
      });
      if (result.ok) {
        setRunName("");
        setOwnedNotice(request, {
          tone: "success",
          message: `发布运行“${result.data.name}”已创建，包含 ${result.data.requirements.length} 项覆盖要求。`,
          englishMessage: `Release run “${result.data.name}” created with ${result.data.requirements.length} coverage requirements.`
        });
        await data.refresh();
        if (mountedRef.current && navigationVersionRef.current === navigationVersion) {
          setRememberedRunId(result.data.id);
          writeRunParam(result.data.id, true);
          setCreateOpen(false);
        }
      } else {
        setOwnedNotice(request, { tone: "error", message: result.error.message });
      }
    } finally {
      finishMutation(request);
    }
  };

  const applyRunStatus = async (run: TestingRun, status: TestingRunStatus) => {
    const request = beginMutation({ kind: "run-status", id: run.id });
    try {
      const result = await data.updateRun(run.id, { status });
      if (result.ok) {
        setOwnedNotice(request, {
          tone: "success",
          message: `发布运行状态已更新为${testingRunStatusLabel(result.data.status, "zh-CN")}。`,
          englishMessage: `Release run status updated to ${testingRunStatusLabel(result.data.status, "en-US")}.`
        });
        await data.refresh();
      } else {
        setOwnedNotice(request, { tone: "error", message: result.error.message });
      }
    } finally {
      finishMutation(request);
    }
  };

  const changeRunStatus = (run: TestingRun, status: TestingRunStatus) => {
    if (status === "approved") {
      // The generic lifecycle select must never approve; the dedicated action owns that.
      setTransientNotice({
        tone: "error",
        message: "请使用“批准发布”操作完成批准。",
        englishMessage: "Use the “Approve release” action to approve."
      });
      return;
    }
    return applyRunStatus(run, status);
  };

  const assignRequirement = async (run: TestingRun, requirementId: string) => {
    const request = beginMutation({ kind: "assignment", runId: run.id, requirementId });
    const owner = assignee.trim() || user.username;
    try {
      const result = await data.createAssignment(run.id, requirementId, owner);
      if (result.ok) {
        setOwnedNotice(request, {
          tone: "success",
          message: `覆盖任务已分配给 ${owner}。`,
          englishMessage: `Coverage task assigned to ${owner}.`
        });
        await data.refresh();
      } else {
        setOwnedNotice(request, { tone: "error", message: result.error.message });
      }
    } finally {
      finishMutation(request);
    }
  };

  const linkAssignment = (runId: string, assignmentId: string, testCaseId: string) => {
    setTransientNotice({
      tone: "success",
      message: "任务已关联；下一次语音会话将计入此发布任务。",
      englishMessage: "Task linked. Your next voice session will count toward this release task."
    });
    agent.setTestingAssignmentContext(runId, assignmentId, testCaseId);
  };

  const openEvidence = (build: string, platform?: string) => {
    navigate("evidence", {
      build,
      platform: platform && platform !== "unknown" ? platform : null
    });
  };

  const jumpToMissingCoverage = (run: TestingRun) => {
    const missing = coverageGroups(run)
      .flatMap((group) => group.rows)
      .find((row) => !row.complete);
    if (!missing || typeof document === "undefined" || !document.getElementById) return;
    const element = document.getElementById(`coverage-row-${run.id}-${missing.requirement.id}`);
    element?.scrollIntoView?.({ behavior: "smooth", block: "center" });
    element?.focus?.();
  };

  const gateFacts = (run: TestingRun) => {
    const expectedBuild = agent.health?.build?.gitCommit;
    return {
      missingCoverage: coverageGroups(run).some((group) => group.rows.some((row) => !row.complete)),
      openReviews: (data.operations?.reviews ?? []).filter(
        (review) => review.runId === run.id && (review.status === "open" || review.status === "triaged")
      ).length,
      stale: data.status !== "ready",
      buildMismatch:
        !!data.testing &&
        (!testingBuildsMatch(run.build, data.testing.releaseGate.build) ||
          (!!expectedBuild && !testingBuildsMatch(data.testing.releaseGate.build, expectedBuild)))
    };
  };

  const gateActions = (run: TestingRun): ReactNode => {
    const facts = gateFacts(run);
    const actions: ReactNode[] = [];
    if (facts.stale || facts.buildMismatch) {
      actions.push(
        <button key="sync" type="button" onClick={() => void data.refresh()}>
          {localized(language, "重新同步发布数据", "Sync release data")}
        </button>
      );
    }
    if (facts.openReviews) {
      actions.push(
        <button key="reviews" type="button" onClick={() => navigate("evidence", { build: run.build, review: "open" })}>
          {localized(language, `处理未完成复核（${facts.openReviews}）`, `Resolve open reviews (${facts.openReviews})`)}
        </button>
      );
    }
    if (facts.missingCoverage) {
      actions.push(
        <button key="coverage" type="button" onClick={() => jumpToMissingCoverage(run)}>
          {localized(language, "跳到缺失覆盖", "Jump to missing coverage")}
        </button>
      );
    }
    actions.push(
      <button key="evidence" type="button" onClick={() => openEvidence(run.build)}>
        {localized(language, "查看证据", "View evidence")}
      </button>
    );
    return <div className="releaseGateActions">{actions}</div>;
  };

  const openApproval = () => {
    if (!isAdmin || !selectedRun || selectedRun.status === "approved" || selectedRun.status === "archived") return;
    noticeRequestRef.current = ++mutationSequenceRef.current;
    setNotice(null);
    setApproval({ runId: selectedRun.id, build: selectedRun.build, status: selectedRun.status });
  };

  const approvalMismatch: string[] = [];
  if (approval) {
    if (!dialogRun) {
      approvalMismatch.push(
        localized(
          language,
          "该发布运行已不可见，可能已被删除。",
          "This release run is no longer visible and may have been deleted."
        )
      );
    } else {
      if (dialogRun.build !== approval.build)
        approvalMismatch.push(localized(language, "构建在确认期间发生了变化。", "The build changed while confirming."));
      if (dialogRun.status !== approval.status)
        approvalMismatch.push(
          localized(language, "状态在确认期间发生了变化。", "The status changed while confirming.")
        );
    }
  }

  const approvalConfirmable =
    !!approval &&
    !!dialogRun &&
    approvalMismatch.length === 0 &&
    dialogBlockers.length === 0 &&
    data.status === "ready" &&
    isAdmin;
  const approving = approval ? busyTargets.has(`run-status:${approval.runId}`) : false;

  const confirmApproval = async () => {
    if (!approval) return;
    // Re-evaluate against the data the user is actually looking at right now.
    const freshRun = runs.find((run) => run.id === approval.runId);
    const freshBlockers = freshRun ? blockersFor(freshRun) : [];
    const changed =
      !freshRun ||
      freshRun.build !== approval.build ||
      freshRun.status !== approval.status ||
      !isAdmin ||
      data.status !== "ready" ||
      freshBlockers.length > 0;
    if (changed) {
      setTransientNotice({
        tone: "error",
        message: "批准条件已变化，请查看最新阻断项后重试。",
        englishMessage: "Approval conditions changed. Review the latest blockers and try again."
      });
      return;
    }
    const request = beginMutation({ kind: "run-status", id: freshRun.id });
    try {
      const result = await data.updateRun(freshRun.id, { status: "approved" });
      if (result.ok) {
        setApproval(null);
        setOwnedNotice(request, {
          tone: "success",
          message: `发布“${result.data.name}”已批准。`,
          englishMessage: `Release “${result.data.name}” approved.`
        });
        await data.refresh();
      } else {
        setOwnedNotice(request, { tone: "error", message: result.error.message });
      }
    } finally {
      finishMutation(request);
    }
  };

  const groups = selectedRun ? coverageGroups(selectedRun) : [];
  const progress = selectedRun ? runProgress(selectedRun) : { required: 0, completed: 0, percent: 0 };
  const dueLabel = selectedRun ? dueDateLabel(selectedRun.dueAt) : "";

  return (
    <section
      className="testingControlPlane adminSectionCard"
      aria-label={localized(language, "发布验证", "Release validation")}
    >
      <div className="controlPlaneHead adminSectionHeader">
        <div>
          <span>MAX QA · {localized(language, "发布", "Release")}</span>
          <strong>
            {isReviewer
              ? localized(language, "发布运行与覆盖矩阵", "Release runs & coverage")
              : localized(language, "我的覆盖任务", "My coverage tasks")}
          </strong>
        </div>
        {isReviewer ? (
          <div className="releaseHeadActions">
            {!createOpen && createDraftDirty ? (
              <span className="releaseDraftBadge">{localized(language, "草稿已保留", "Draft kept")}</span>
            ) : null}
            <button
              type="button"
              className={createOpen ? "" : "primary"}
              aria-expanded={createOpen}
              onClick={() => setCreateOpen((open) => !open)}
            >
              {createOpen
                ? localized(language, "收起创建表单", "Close create form")
                : localized(language, "新建发布运行", "New release run")}
            </button>
          </div>
        ) : null}
      </div>

      {notice ? (
        <p className={`adminNotice ${notice.tone}`} role="status">
          {localized(language, notice.message, notice.englishMessage ?? notice.message)}
        </p>
      ) : null}

      <div className="controlPlaneBody">
        {isReviewer && createOpen ? (
          <div className="runCreateBar">
            <label>
              <span>{localized(language, "运行名称", "Run name")}</span>
              <input
                value={runName}
                disabled={busyTargets.has("create-run")}
                onChange={(event) => setRunName(event.target.value)}
                placeholder={localized(language, "候选发布", "Candidate release")}
              />
            </label>
            <label>
              <span>{localized(language, "构建", "Build")}</span>
              <input
                value={runBuild}
                disabled={busyTargets.has("create-run")}
                onChange={(event) => setRunBuild(event.target.value)}
              />
            </label>
            <label>
              <span>{localized(language, "负责人", "Owner")}</span>
              <input
                value={runOwner}
                disabled={busyTargets.has("create-run")}
                onChange={(event) => setRunOwner(event.target.value)}
              />
            </label>
            <label>
              <span>{localized(language, "截止日期", "Due date")}</span>
              <input
                type="date"
                value={runDueDate}
                disabled={busyTargets.has("create-run")}
                onChange={(event) => setRunDueDate(event.target.value)}
              />
            </label>
            <button type="button" disabled={busyTargets.has("create-run")} onClick={() => void createRun()}>
              {busyTargets.has("create-run")
                ? localized(language, "正在创建…", "Creating…")
                : localized(language, "创建发布运行", "Create release run")}
            </button>
          </div>
        ) : null}

        <div className="releaseRunGrid adminDataSplit">
          <div className="releaseRunList">
            {runs.map((run) => {
              const runItemProgress = runProgress(run);
              return (
                <button
                  key={run.id}
                  type="button"
                  className={selectedRun?.id === run.id ? "active" : ""}
                  onClick={() => selectRun(run.id)}
                >
                  <span className={`adminStatus ${run.status}`}>{testingRunStatusLabel(run.status, language)}</span>
                  <strong>{run.name}</strong>
                  <small>
                    {run.build} · {runItemProgress.completed}/{runItemProgress.required}{" "}
                    {localized(language, "个样本", "samples")}
                  </small>
                  <i>
                    <b style={{ width: `${runItemProgress.percent}%` }} />
                  </i>
                </button>
              );
            })}
            {!runs.length ? (
              <p className="testerConversationEmpty">
                {isReviewer
                  ? localized(
                      language,
                      "还没有发布运行，从右上角创建第一个。",
                      "No release runs yet. Create the first one top right."
                    )
                  : localized(language, "暂无发布运行或已分配任务。", "No release runs or assigned tasks.")}
              </p>
            ) : null}
          </div>

          <div className="releaseRunDetail">
            {selectedRun ? (
              <>
                <div className="releaseRunTitle">
                  <div>
                    <span>{selectedRun.build}</span>
                    <strong>{selectedRun.name}</strong>
                    <p>
                      {localized(language, "负责人", "Owner")} {selectedRun.owner} ·{" "}
                      {localized(language, "策略", "Policy")} {selectedRun.policyVersion}
                      {dueLabel ? ` · ${localized(language, "截止", "Due")} ${dueLabel}` : ""}
                      {selectedRun.status === "approved" && selectedRun.approvedBy
                        ? ` · ${localized(language, "已由", "Approved by")} ${selectedRun.approvedBy}${
                            selectedRun.approvedAt
                              ? ` · ${formatAdminRelativeTime(selectedRun.approvedAt, language)}`
                              : ""
                          }`
                        : ""}
                    </p>
                  </div>
                  <div className="releaseRunActions">
                    {isReviewer ? (
                      <select
                        aria-label={localized(language, "发布运行状态", "Release run status")}
                        value={selectedRun.status}
                        disabled={busyTargets.has(`run-status:${selectedRun.id}`)}
                        onChange={(event) => void changeRunStatus(selectedRun, event.target.value as TestingRunStatus)}
                      >
                        {RUN_STATUSES.filter((status) =>
                          selectedRun.status === "archived"
                            ? status === "archived"
                            : selectedRun.status === "approved"
                              ? status === "approved" || status === "archived"
                              : status !== "approved"
                        ).map((status) => (
                          <option key={status} value={status} disabled={status === "approved"}>
                            {testingRunStatusLabel(status, language)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className={`runStatus adminStatus ${selectedRun.status}`}>
                        {testingRunStatusLabel(selectedRun.status, language)}
                      </span>
                    )}
                    {isAdmin && selectedRun.status !== "approved" && selectedRun.status !== "archived" ? (
                      <button type="button" className="releaseApproveAction primary" onClick={openApproval}>
                        {localized(language, "批准发布…", "Approve release…")}
                      </button>
                    ) : null}
                  </div>
                </div>
                <div className="releaseProgress" aria-label={localized(language, "覆盖进度", "Coverage progress")}>
                  <i>
                    <b style={{ width: `${progress.percent}%` }} />
                  </i>
                  <span>
                    {progress.completed}/{progress.required} {localized(language, "个证据样本", "evidence samples")} ·{" "}
                    {progress.percent}%
                  </span>
                </div>
                {isReviewer &&
                selectedRun.status !== "approved" &&
                selectedRun.status !== "archived" &&
                approvalBlockers.length ? (
                  <section
                    className="adminNotice error"
                    aria-label={localized(language, "批准阻断项", "Approval blockers")}
                  >
                    <strong>{localized(language, "批准受阻", "Approval blocked")}</strong>
                    <ul>
                      {approvalBlockers.map((blocker, index) => (
                        <li key={`${index}-${blocker}`}>{blocker}</li>
                      ))}
                    </ul>
                    {gateActions(selectedRun)}
                  </section>
                ) : null}
                {isReviewer ? (
                  <label className="assignmentOwner">
                    <span>{localized(language, "新任务分配给", "Assign new task to")}</span>
                    <input
                      value={assignee}
                      onChange={(event) => setAssignee(event.target.value)}
                      placeholder={localized(language, "测试员用户名", "Tester username")}
                    />
                  </label>
                ) : null}
                <div className="releaseCoverage">
                  {groups.map((group) => {
                    const groupRequired = group.rows.reduce(
                      (sum, row) => sum + row.requirement.requiredValidSessions,
                      0
                    );
                    const groupCompleted = group.rows.reduce(
                      (sum, row) => sum + Math.min(row.completed, row.requirement.requiredValidSessions),
                      0
                    );
                    const groupComplete = group.rows.every((row) => row.complete);
                    return (
                      <section
                        key={group.testCaseId}
                        className={`coverageCaseGroup${groupComplete ? " complete" : ""}`}
                      >
                        <header className="coverageCaseHead">
                          <strong>{group.name}</strong>
                          <span>
                            {groupCompleted}/{groupRequired} {localized(language, "个证据样本", "evidence samples")}
                          </span>
                          <i>
                            <b
                              style={{
                                width: `${groupRequired ? Math.min(100, Math.round((groupCompleted / groupRequired) * 100)) : 0}%`
                              }}
                            />
                          </i>
                        </header>
                        <ul className="coverageRequirementRows">
                          {group.rows.map((row) => {
                            const mine = row.assignments.find(
                              (item) => item.assignee === user.username && item.status !== "complete"
                            );
                            const assigning = busyTargets.has(`assignment:${selectedRun.id}:${row.requirement.id}`);
                            return (
                              <li
                                key={row.requirement.id}
                                id={`coverage-row-${selectedRun.id}-${row.requirement.id}`}
                                tabIndex={-1}
                                className={`coverageRequirementRow ${row.complete ? "complete" : "pending"}`}
                              >
                                <span className={`coveragePlatform ${row.requirement.platform}`}>
                                  {row.requirement.platform}
                                </span>
                                <span className="coverageRequirementMeta">
                                  {row.requirement.networkType} · {row.requirement.language}
                                </span>
                                <span className="coverageRequirementCount">
                                  {row.completed}/{row.requirement.requiredValidSessions}
                                </span>
                                <div className="coverageAssignees">
                                  {row.assignments.length ? (
                                    row.assignments.map((item) => (
                                      <span key={item.id}>
                                        {item.assignee} · {testingAssignmentStatusLabel(item.status, language)}
                                      </span>
                                    ))
                                  ) : (
                                    <span className="coverageUnassigned">
                                      {localized(language, "未分配", "Unassigned")}
                                    </span>
                                  )}
                                </div>
                                <div className="coverageRowActions">
                                  {isReviewer ? (
                                    <>
                                      <button
                                        type="button"
                                        disabled={assigning}
                                        onClick={() => void assignRequirement(selectedRun, row.requirement.id)}
                                      >
                                        {assigning
                                          ? localized(language, "正在分配…", "Assigning…")
                                          : localized(language, "分配任务", "Assign task")}
                                      </button>
                                      <button
                                        type="button"
                                        className="coverageEvidenceLink"
                                        onClick={() => openEvidence(selectedRun.build, row.requirement.platform)}
                                      >
                                        {row.complete
                                          ? localized(language, "查看证据", "View evidence")
                                          : localized(language, "补充证据", "Collect evidence")}
                                      </button>
                                    </>
                                  ) : mine && (mine.platform === "web" || mine.platform === "unknown") ? (
                                    <button
                                      type="button"
                                      onClick={() => linkAssignment(selectedRun.id, mine.id, mine.testCaseId)}
                                    >
                                      {localized(language, "用于下一次会话", "Use for next session")}
                                    </button>
                                  ) : mine ? (
                                    <small>
                                      {localized(language, "请打开", "Open")} {mine.platform}{" "}
                                      {localized(language, "客户端采集此任务。", "client to collect this task.")}
                                    </small>
                                  ) : null}
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      </section>
                    );
                  })}
                  {!groups.length ? (
                    <p className="testerConversationEmpty">
                      {localized(language, "此运行没有覆盖要求。", "This run has no coverage requirements.")}
                    </p>
                  ) : null}
                </div>
              </>
            ) : urlRunId ? (
              <div className="releaseEmpty" role="status">
                <strong>{localized(language, "发布运行不可用", "Release run unavailable")}</strong>
                <p>
                  {localized(
                    language,
                    "该运行不存在、已删除，或当前账号无权访问。",
                    "This run does not exist, was removed, or is not available to your account."
                  )}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setRememberedRunId(null);
                    navigate("releases", { run: null });
                  }}
                >
                  {localized(language, "查看可用运行", "Show available runs")}
                </button>
              </div>
            ) : isReviewer ? (
              <div className="releaseEmpty">
                <strong>{localized(language, "还没有发布运行", "No release runs yet")}</strong>
                <p>
                  {localized(
                    language,
                    "创建第一个发布运行，按 web / iOS / Android 跟踪证据覆盖，全部就绪后再批准发布。",
                    "Create the first release run, track evidence coverage across web / iOS / Android, then approve it once everything is ready."
                  )}
                </p>
                <button type="button" className="primary" onClick={() => setCreateOpen(true)}>
                  {localized(language, "新建发布运行", "New release run")}
                </button>
              </div>
            ) : (
              <p className="testerConversationEmpty">
                {localized(language, "暂无发布运行或已分配任务。", "No release runs or assigned tasks.")}
              </p>
            )}
          </div>
        </div>
      </div>

      {approval ? (
        <div
          ref={approvalDialogRef}
          tabIndex={-1}
          className="releaseApproveDialog"
          role="dialog"
          aria-modal="true"
          aria-label={localized(language, "确认批准发布", "Confirm release approval")}
        >
          <div className="releaseApprovePanel">
            <header className="releaseApproveHead">
              <strong>{localized(language, "确认批准发布", "Confirm release approval")}</strong>
              <button
                type="button"
                className="releaseApproveClose"
                aria-label={localized(language, "关闭", "Close")}
                onClick={() => setApproval(null)}
              >
                ×
              </button>
            </header>
            {dialogRun ? (
              <dl className="releaseApproveFacts">
                <div>
                  <dt>{localized(language, "发布运行", "Release run")}</dt>
                  <dd>{dialogRun.name}</dd>
                </div>
                <div>
                  <dt>{localized(language, "构建", "Build")}</dt>
                  <dd>
                    {dialogRun.build}
                    {data.testing && testingBuildsMatch(dialogRun.build, data.testing.releaseGate.build)
                      ? ` · ${localized(language, "与证据一致", "matches evidence")}`
                      : ""}
                  </dd>
                </div>
                <div>
                  <dt>{localized(language, "覆盖进度", "Coverage")}</dt>
                  <dd>
                    {(() => {
                      const dialogProgress = runProgress(dialogRun);
                      return `${dialogProgress.completed}/${dialogProgress.required} · ${dialogProgress.percent}%`;
                    })()}
                  </dd>
                </div>
                <div>
                  <dt>{localized(language, "数据同步", "Data sync")}</dt>
                  <dd>
                    {data.status === "ready"
                      ? localized(language, "最新", "current")
                      : localized(language, "待同步", "stale")}
                    {data.lastSyncedAt ? ` · ${formatAdminRelativeTime(data.lastSyncedAt, language)}` : ""}
                  </dd>
                </div>
              </dl>
            ) : null}
            {approvalMismatch.length ? (
              <div className="adminNotice error" role="alert">
                <strong>{localized(language, "确认信息已过期", "Confirmation is out of date")}</strong>
                <ul>
                  {approvalMismatch.map((reason, index) => (
                    <li key={`${index}-${reason}`}>{reason}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {dialogBlockers.length ? (
              <div className="adminNotice error">
                <strong>{localized(language, "仍存在批准阻断项", "Approval blockers remain")}</strong>
                <ul>
                  {dialogBlockers.map((blocker, index) => (
                    <li key={`${index}-${blocker}`}>{blocker}</li>
                  ))}
                </ul>
                {dialogRun ? gateActions(dialogRun) : null}
              </div>
            ) : approvalMismatch.length === 0 && dialogRun ? (
              <p className="releaseApproveReady">
                {localized(
                  language,
                  "全部检查通过，确认后将批准此构建发布。",
                  "All checks pass. Confirming will approve this build for release."
                )}
              </p>
            ) : null}
            <footer className="releaseApproveActions">
              <button type="button" onClick={() => setApproval(null)}>
                {localized(language, "取消", "Cancel")}
              </button>
              <button
                type="button"
                className="primary"
                disabled={!approvalConfirmable || approving}
                onClick={() => void confirmApproval()}
              >
                {approving
                  ? localized(language, "正在批准…", "Approving…")
                  : localized(language, "确认批准", "Confirm approval")}
              </button>
            </footer>
          </div>
        </div>
      ) : null}
    </section>
  );
}
