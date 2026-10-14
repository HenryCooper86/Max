import { useEffect, useRef, useState } from "react";
import { TESTING_TEST_CASES, type TestingRun, type TestingRunStatus } from "../../../shared/testing";
import type { HelmetAgent } from "../../hooks/useHelmetAgent";
import { useLanguage } from "../LanguageToggle";
import { localized } from "../../lib/i18n";
import type { AuthUser } from "../../lib/auth";
import { releaseApprovalBlockers, testingAssignmentStatusLabel, testingRunStatusLabel } from "./admin-model";
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

const RUN_STATUSES: TestingRunStatus[] = ["draft", "active", "blocked", "ready", "approved", "archived"];

function caseName(testCaseId: string) {
  return TESTING_TEST_CASES.find((item) => item.id === testCaseId)?.name ?? testCaseId;
}

function runProgress(run: TestingRun) {
  const required = run.requirements.reduce((sum, requirement) => sum + requirement.requiredValidSessions, 0);
  const completed = run.assignments.reduce((sum, assignment) => sum + assignment.completedSessionIds.length, 0);
  return { required, completed, percent: required ? Math.min(100, Math.round((completed / required) * 100)) : 0 };
}

function busyTargetKey(target: Exclude<BusyTarget, null>) {
  if (target.kind === "create-run") return "create-run";
  if (target.kind === "run-status") return `run-status:${target.id}`;
  return `assignment:${target.runId}:${target.requirementId}`;
}

export function ReleaseValidation({ agent, user, data }: Props) {
  const { language } = useLanguage();
  const isReviewer = user.role === "admin" || user.role === "reviewer";
  const currentBuild = agent.health?.build?.gitCommit ?? "local";
  const runs = isReviewer ? (data.operations?.runs ?? []) : data.runs;
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [busyTargets, setBusyTargets] = useState<ReadonlySet<string>>(() => new Set());
  const [notice, setNotice] = useState<Notice | null>(null);
  const [runName, setRunName] = useState("");
  const [runBuild, setRunBuild] = useState(currentBuild);
  const [runOwner, setRunOwner] = useState(user.username);
  const [runDueDate, setRunDueDate] = useState("");
  const [assignee, setAssignee] = useState(user.username);
  const mutationSequenceRef = useRef(0);
  const targetRequestRef = useRef(new Map<string, number>());
  const noticeRequestRef = useRef(0);
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? runs[0];
  const approvalBlockers = selectedRun
    ? releaseApprovalBlockers(
        selectedRun,
        data.testing,
        data.operations?.reviews,
        language,
        agent.health?.build?.gitCommit
      )
    : [];
  if (data.status !== "ready")
    approvalBlockers.unshift(localized(language, "发布数据尚未同步", "Release data is not current."));

  useEffect(() => setRunBuild(currentBuild), [currentBuild]);

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

  const createRun = async () => {
    const request = beginMutation({ kind: "create-run" });
    try {
      const result = await data.createRun({
        name: runName.trim() || localized(language, `发布 ${runBuild}`, `Release ${runBuild}`),
        build: runBuild.trim() || currentBuild,
        owner: runOwner.trim() || user.username,
        dueAt: runDueDate ? new Date(`${runDueDate}T23:59:59`).getTime() : undefined
      });
      if (result.ok) {
        setRunName("");
        setSelectedRunId(result.data.id);
        setOwnedNotice(request, {
          tone: "success",
          message: `发布运行“${result.data.name}”已创建，包含 ${result.data.requirements.length} 项覆盖要求。`,
          englishMessage: `Release run “${result.data.name}” created with ${result.data.requirements.length} coverage requirements.`
        });
        await data.refresh();
      } else {
        setOwnedNotice(request, { tone: "error", message: result.error.message });
      }
    } finally {
      finishMutation(request);
    }
  };

  const changeRunStatus = async (run: TestingRun, status: TestingRunStatus) => {
    if (status === "approved" && (user.role !== "admin" || approvalBlockers.length)) {
      noticeRequestRef.current = ++mutationSequenceRef.current;
      setNotice({
        tone: "error",
        message: `发布批准受阻：${approvalBlockers[0] ?? "需要管理员权限"}`,
        englishMessage: `Approval blocked: ${approvalBlockers[0] ?? "Administrator access required."}`
      });
      return;
    }
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
    noticeRequestRef.current = ++mutationSequenceRef.current;
    agent.setTestingAssignmentContext(runId, assignmentId, testCaseId);
    setNotice({
      tone: "success",
      message: "任务已关联；下一次语音会话将计入此发布任务。",
      englishMessage: "Task linked. Your next voice session will count toward this release task."
    });
  };

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
      </div>

      {notice ? (
        <p className={`adminNotice ${notice.tone}`} role="status">
          {localized(language, notice.message, notice.englishMessage ?? notice.message)}
        </p>
      ) : null}

      <div className="controlPlaneBody">
        {isReviewer ? (
          <div className="runCreateBar">
            <label>
              <span>{localized(language, "运行名称", "Run name")}</span>
              <input
                value={runName}
                disabled={busyTargets.has("create-run")}
                onChange={(event) => setRunName(event.target.value)}
                placeholder={localized(language, "七月候选发布", "July candidate release")}
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
              const progress = runProgress(run);
              return (
                <button
                  key={run.id}
                  type="button"
                  className={selectedRun?.id === run.id ? "active" : ""}
                  onClick={() => setSelectedRunId(run.id)}
                >
                  <span className={`adminStatus ${run.status}`}>{testingRunStatusLabel(run.status, language)}</span>
                  <strong>{run.name}</strong>
                  <small>
                    {run.build} · {progress.completed}/{progress.required} {localized(language, "个样本", "samples")}
                  </small>
                  <i>
                    <b style={{ width: `${progress.percent}%` }} />
                  </i>
                </button>
              );
            })}
            {!runs.length ? (
              <p className="testerConversationEmpty">
                {localized(language, "暂无发布运行或已分配任务。", "No release runs or assigned tasks.")}
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
                    </p>
                  </div>
                  {isReviewer ? (
                    <select
                      aria-label={localized(language, "发布运行状态", "Release run status")}
                      value={selectedRun.status}
                      disabled={busyTargets.has(`run-status:${selectedRun.id}`)}
                      onChange={(event) => void changeRunStatus(selectedRun, event.target.value as TestingRunStatus)}
                    >
                      {RUN_STATUSES.filter(
                        (status) => status === selectedRun.status || status !== "approved" || user.role === "admin"
                      ).map((status) => (
                        <option
                          key={status}
                          value={status}
                          disabled={status === "approved" && (user.role !== "admin" || approvalBlockers.length > 0)}
                        >
                          {testingRunStatusLabel(status, language)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className={`runStatus adminStatus ${selectedRun.status}`}>
                      {testingRunStatusLabel(selectedRun.status, language)}
                    </span>
                  )}
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
                <div className="coverageMatrix">
                  {selectedRun.requirements.map((requirement) => {
                    const assignments = selectedRun.assignments.filter((item) => item.requirementId === requirement.id);
                    const completed = assignments.reduce((sum, item) => sum + item.completedSessionIds.length, 0);
                    const mine = assignments.find(
                      (item) => item.assignee === user.username && item.status !== "complete"
                    );
                    const assigning = busyTargets.has(`assignment:${selectedRun.id}:${requirement.id}`);
                    return (
                      <article
                        key={requirement.id}
                        className={completed >= requirement.requiredValidSessions ? "complete" : "pending"}
                      >
                        <div>
                          <strong>{caseName(requirement.testCaseId)}</strong>
                          <span>
                            {requirement.platform} · {requirement.networkType} · {requirement.language}
                          </span>
                        </div>
                        <p>
                          {completed}/{requirement.requiredValidSessions}{" "}
                          {localized(language, "个证据样本", "evidence samples")}
                        </p>
                        <div className="coverageAssignments">
                          {assignments.map((item) => (
                            <span key={item.id}>
                              {item.assignee} · {testingAssignmentStatusLabel(item.status, language)}
                            </span>
                          ))}
                        </div>
                        {isReviewer ? (
                          <button
                            type="button"
                            disabled={assigning}
                            onClick={() => void assignRequirement(selectedRun, requirement.id)}
                          >
                            {assigning
                              ? localized(language, "正在分配…", "Assigning…")
                              : localized(language, "分配任务", "Assign task")}
                          </button>
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
                      </article>
                    );
                  })}
                </div>
              </>
            ) : (
              <p className="testerConversationEmpty">
                {localized(language, "请选择或创建发布运行。", "Select or create a release run.")}
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
