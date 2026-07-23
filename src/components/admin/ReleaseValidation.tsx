import { useEffect, useRef, useState } from "react";
import { TESTING_TEST_CASES, type TestingRun, type TestingRunStatus } from "../../../shared/testing";
import type { HelmetAgent } from "../../hooks/useHelmetAgent";
import type { AuthUser } from "../../lib/auth";
import { testingAssignmentStatusLabel, testingRunStatusLabel } from "./admin-model";
import type { AdminTestingData } from "./useAdminTestingData";

type BusyTarget =
  | { kind: "create-run" }
  | { kind: "run-status"; id: string }
  | { kind: "assignment"; runId: string; requirementId: string }
  | null;

type Notice = { tone: "success" | "error"; message: string };
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
        name: runName.trim() || `发布 ${runBuild}`,
        build: runBuild.trim() || currentBuild,
        owner: runOwner.trim() || user.username,
        dueAt: runDueDate ? new Date(`${runDueDate}T23:59:59`).getTime() : undefined
      });
      if (result.ok) {
        setRunName("");
        setSelectedRunId(result.data.id);
        setOwnedNotice(request, {
          tone: "success",
          message: `发布运行“${result.data.name}”已创建，包含 ${result.data.requirements.length} 项覆盖要求。`
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
    const request = beginMutation({ kind: "run-status", id: run.id });
    try {
      const result = await data.updateRun(run.id, { status });
      if (result.ok) {
        setOwnedNotice(request, {
          tone: "success",
          message: `发布运行状态已更新为${testingRunStatusLabel(result.data.status)}。`
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
        setOwnedNotice(request, { tone: "success", message: `覆盖任务已分配给 ${owner}。` });
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
    setNotice({ tone: "success", message: "任务已关联；下一次语音会话将计入此发布任务。" });
  };

  return (
    <section className="testingControlPlane adminSectionCard" aria-label="发布验证">
      <div className="controlPlaneHead adminSectionHeader">
        <div>
          <span>MAX QA · 发布</span>
          <strong>{isReviewer ? "发布运行与覆盖矩阵" : "我的覆盖任务"}</strong>
        </div>
      </div>

      {notice ? (
        <p className={`adminNotice ${notice.tone}`} role="status">
          {notice.message}
        </p>
      ) : null}

      <div className="controlPlaneBody">
        {isReviewer ? (
          <div className="runCreateBar">
            <label>
              <span>运行名称</span>
              <input value={runName} onChange={(event) => setRunName(event.target.value)} placeholder="七月候选发布" />
            </label>
            <label>
              <span>构建</span>
              <input value={runBuild} onChange={(event) => setRunBuild(event.target.value)} />
            </label>
            <label>
              <span>负责人</span>
              <input value={runOwner} onChange={(event) => setRunOwner(event.target.value)} />
            </label>
            <label>
              <span>截止日期</span>
              <input type="date" value={runDueDate} onChange={(event) => setRunDueDate(event.target.value)} />
            </label>
            <button type="button" disabled={busyTargets.has("create-run")} onClick={() => void createRun()}>
              {busyTargets.has("create-run") ? "正在创建…" : "创建发布运行"}
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
                  <span className={`adminStatus ${run.status}`}>{testingRunStatusLabel(run.status)}</span>
                  <strong>{run.name}</strong>
                  <small>
                    {run.build} · {progress.completed}/{progress.required} 个样本
                  </small>
                  <i>
                    <b style={{ width: `${progress.percent}%` }} />
                  </i>
                </button>
              );
            })}
            {!runs.length ? <p className="testerConversationEmpty">暂无发布运行或已分配任务。</p> : null}
          </div>

          <div className="releaseRunDetail">
            {selectedRun ? (
              <>
                <div className="releaseRunTitle">
                  <div>
                    <span>{selectedRun.build}</span>
                    <strong>{selectedRun.name}</strong>
                    <p>
                      负责人 {selectedRun.owner} · 策略 {selectedRun.policyVersion}
                    </p>
                  </div>
                  {isReviewer ? (
                    <select
                      aria-label="发布运行状态"
                      value={selectedRun.status}
                      disabled={busyTargets.has(`run-status:${selectedRun.id}`)}
                      onChange={(event) => void changeRunStatus(selectedRun, event.target.value as TestingRunStatus)}
                    >
                      {RUN_STATUSES.filter(
                        (status) => status === selectedRun.status || status !== "approved" || user.role === "admin"
                      ).map((status) => (
                        <option key={status} value={status} disabled={status === "approved" && user.role !== "admin"}>
                          {testingRunStatusLabel(status)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className={`runStatus adminStatus ${selectedRun.status}`}>
                      {testingRunStatusLabel(selectedRun.status)}
                    </span>
                  )}
                </div>
                {isReviewer ? (
                  <label className="assignmentOwner">
                    <span>新任务分配给</span>
                    <input
                      value={assignee}
                      onChange={(event) => setAssignee(event.target.value)}
                      placeholder="测试员用户名"
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
                          {completed}/{requirement.requiredValidSessions} 个证据样本
                        </p>
                        <div className="coverageAssignments">
                          {assignments.map((item) => (
                            <span key={item.id}>
                              {item.assignee} · {testingAssignmentStatusLabel(item.status)}
                            </span>
                          ))}
                        </div>
                        {isReviewer ? (
                          <button
                            type="button"
                            disabled={assigning}
                            onClick={() => void assignRequirement(selectedRun, requirement.id)}
                          >
                            {assigning ? "正在分配…" : "分配任务"}
                          </button>
                        ) : mine && (mine.platform === "web" || mine.platform === "unknown") ? (
                          <button
                            type="button"
                            onClick={() => linkAssignment(selectedRun.id, mine.id, mine.testCaseId)}
                          >
                            用于下一次会话
                          </button>
                        ) : mine ? (
                          <small>请打开 {mine.platform} 客户端采集此任务。</small>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              </>
            ) : (
              <p className="testerConversationEmpty">请选择或创建发布运行。</p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
