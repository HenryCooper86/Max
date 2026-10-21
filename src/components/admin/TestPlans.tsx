import { useMemo } from "react";
import {
  TESTING_TEST_CASES,
  type TestingAssignment,
  type TestingRun,
  type TestingRunRequirement
} from "../../../shared/testing";
import type { HelmetAgent } from "../../hooks/useHelmetAgent";
import type { AuthUser } from "../../lib/auth";
import { useLanguage } from "../LanguageToggle";
import { localized, type Language } from "../../lib/i18n";
import { formatAdminRelativeTime, testingAssignmentStatusLabel, testingRunStatusLabel } from "./admin-model";
import { testingPlatformLabel, testingSessionTitle, testingTaskInstructions } from "./testing-presentation";
import type { AdminTestingData } from "./useAdminTestingData";

type Props = {
  user: AuthUser;
  agent: HelmetAgent;
  data: AdminTestingData;
  onOpenSessions: (filters?: Record<string, string | null>) => void;
  onStartTesting: (prepare?: () => void) => void;
};

type PlanTask = {
  requirement: TestingRunRequirement;
  assignments: TestingAssignment[];
  completed: number;
};

function statusTone(status: TestingRun["status"]) {
  if (status === "approved" || status === "ready") return "good";
  if (status === "blocked") return "alert";
  if (status === "draft" || status === "active" || status === "archived") return "warn";
  return "neutral";
}

function dueDateLabel(dueAt: number | undefined, language: Language) {
  if (!dueAt) return "";
  try {
    return new Intl.DateTimeFormat(language === "en-US" ? "en-US" : "zh-CN", {
      year: "numeric",
      month: "long",
      day: "numeric"
    }).format(new Date(dueAt));
  } catch {
    return "";
  }
}

function networkTypeLabel(value: string, language: Language) {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "any") return localized(language, "网络不限", "Any network");
  if (normalized === "degraded") return localized(language, "弱网环境", "Weak network");
  if (normalized === "field") return localized(language, "实地环境", "Field conditions");
  if (normalized === "wifi") return "Wi-Fi";
  if (normalized === "cellular") return localized(language, "移动网络", "Cellular");
  if (normalized === "ethernet") return localized(language, "有线网络", "Ethernet");
  return localized(language, "指定网络环境", "Specified network");
}

function taskLanguageLabel(value: string, language: Language) {
  if (value === "zh") return localized(language, "中文", "Chinese");
  if (value === "en") return localized(language, "英文", "English");
  return localized(language, "语言不限", "Any language");
}

export function TestPlans({ user, agent, data, onOpenSessions, onStartTesting }: Props) {
  const { language } = useLanguage();
  const isTester = user.role === "tester";
  const catalogCases = data.testing?.catalog?.testCases?.length ? data.testing.catalog.testCases : TESTING_TEST_CASES;

  const runs = useMemo(() => {
    const source = isTester ? data.runs : (data.operations?.runs ?? []);
    return [...source]
      .map((run) => ({
        ...run,
        // Testers see only their own assignments; the server already scopes
        // this, the filter keeps local derivations honest if a stale page
        // ever leaks a wider list.
        assignments: isTester ? run.assignments.filter((item) => item.assignee === user.username) : run.assignments
      }))
      .filter((run) => run.assignments.length > 0 || !isTester)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [data.operations?.runs, data.runs, isTester, user.username]);
  const activePlans = runs.filter((run) => run.status !== "archived");
  const archivedPlans = runs.filter((run) => run.status === "archived");
  const loading = data.status === "loading" && runs.length === 0;

  const startAssignment = (run: TestingRun, assignment: TestingAssignment, testCaseId: string) => {
    // Configure only after the workspace's draft guards accept leaving.
    // Changing context can restart a connected voice session.
    onStartTesting(() => agent.setTestingAssignmentContext(run.id, assignment.id, testCaseId));
  };

  const renderPlan = (run: TestingRun) => {
    // A tester's plan describes their assigned scope only — never the full
    // coverage matrix of the underlying release run.
    const tasks: PlanTask[] = [];
    for (const requirement of run.requirements) {
      const assignments = run.assignments.filter((item) => item.requirementId === requirement.id);
      if (!assignments.length) continue;
      const captured = assignments.reduce((sum, item) => sum + item.completedSessionIds.length, 0);
      tasks.push({
        requirement,
        assignments,
        completed: Math.min(requirement.requiredValidSessions, captured)
      });
    }
    const required = tasks.reduce((sum, task) => sum + task.requirement.requiredValidSessions, 0);
    const completed = tasks.reduce((sum, task) => sum + task.completed, 0);
    const due = dueDateLabel(run.dueAt, language);
    const overdue = Boolean(
      run.dueAt && run.dueAt < Date.now() && run.status !== "approved" && run.status !== "archived"
    );
    return (
      <article className="testingPlanCard" key={run.id}>
        <div className="testingPlanHead">
          <div className="testingPlanTitle">
            <h3>{run.name}</h3>
            <p className="testingPlanMeta">
              <span className={`adminStatus ${statusTone(run.status)}`}>
                {testingRunStatusLabel(run.status, language)}
              </span>
              {due ? (
                <span className={overdue ? "testingOverdue" : ""}>
                  {localized(language, "截止", "Due")} {due}
                  {overdue ? ` · ${localized(language, "已逾期", "Overdue")}` : ""}
                </span>
              ) : null}
              <span>
                {localized(language, "更新于", "Updated")} {formatAdminRelativeTime(run.updatedAt, language)}
              </span>
            </p>
          </div>
          <div className="testingPlanProgress">
            <span>
              {isTester
                ? localized(language, "我的任务", "My tasks")
                : localized(language, "任务进度", "Task progress")}
            </span>
            <strong>
              {completed}/{required}
            </strong>
          </div>
        </div>
        {run.status === "draft" ? (
          <p className="testingPlanNote">
            {localized(
              language,
              "该计划尚未开始，等待组织者启动。",
              "This plan has not started yet; waiting for the organizer."
            )}
          </p>
        ) : null}
        {tasks.length ? (
          <ul className="testingPlanTasks">
            {tasks.map((task) => {
              const testCase = catalogCases.find((item) => item.id === task.requirement.testCaseId);
              const taskName = testingSessionTitle(
                { testCaseId: task.requirement.testCaseId, testCaseName: testCase?.name ?? "" },
                language
              );
              return (
                <li className="testingPlanTask" key={task.requirement.id}>
                  <div className="testingPlanTaskHead">
                    <strong>{taskName}</strong>
                    <span className="testingPlanTaskCount">
                      {task.completed}/{task.requirement.requiredValidSessions}{" "}
                      {localized(language, "次有效测试", "valid sessions")}
                    </span>
                  </div>
                  <p>{testingTaskInstructions(task.requirement.testCaseId, testCase?.description, language)}</p>
                  <div className="testingTaskChips">
                    <span>{testingPlatformLabel(task.requirement.platform, language)}</span>
                    <span>{networkTypeLabel(task.requirement.networkType, language)}</span>
                    <span>{taskLanguageLabel(task.requirement.language, language)}</span>
                  </div>
                  <ul className="testingPlanAssignees">
                    {task.assignments.map((assignment) => {
                      const pending =
                        (run.status === "active" || run.status === "blocked") &&
                        assignment.assignee === user.username &&
                        (assignment.status === "pending" || assignment.status === "in-progress");
                      const browserCompatible = assignment.platform === "web" || assignment.platform === "unknown";
                      const startable = pending && browserCompatible;
                      return (
                        <li className="testingPlanAssignee" key={assignment.id}>
                          <span>
                            {assignment.assignee} · {testingAssignmentStatusLabel(assignment.status, language)}
                          </span>
                          {startable ? (
                            <button
                              type="button"
                              className="testingAssigneeStart"
                              aria-label={`${localized(language, "开始这项测试", "Start this test")}：${taskName}`}
                              onClick={() => startAssignment(run, assignment, task.requirement.testCaseId)}
                            >
                              {localized(language, "开始这项测试", "Start this test")}
                            </button>
                          ) : null}
                          {pending && !browserCompatible ? (
                            <small className="testingPlanNote">
                              {assignment.platform === "embedded"
                                ? localized(
                                    language,
                                    "请使用智能头盔完成这项测试。",
                                    "Use your helmet to complete this test."
                                  )
                                : localized(
                                    language,
                                    `请打开${testingPlatformLabel(assignment.platform, language)}应用完成这项测试。`,
                                    `Open the ${assignment.platform === "ios" ? "iPhone" : "Android"} app to complete this test.`
                                  )}
                            </small>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="testingEmpty">
            {localized(language, "该计划暂无可见的测试任务。", "This plan has no visible test tasks.")}
          </p>
        )}
      </article>
    );
  };

  return (
    <section className="adminSectionCard testingPlans" aria-label={localized(language, "测试计划", "Test plans")}>
      <div className="testingPlansHead">
        <div>
          <h2>{localized(language, "测试计划", "Test plans")}</h2>
          <p>
            {localized(
              language,
              "按计划完成语音测试即可，进度会自动记录。计划为只读；如需调整，请联系组织者。",
              "Complete voice tests against a plan and progress is recorded automatically. Plans are read-only; contact the organizer for changes."
            )}
          </p>
        </div>
        <div className="testingWelcomeActions">
          <button type="button" className="primary" onClick={() => onStartTesting()}>
            {localized(language, "开始语音测试", "Start voice testing")}
          </button>
          <button type="button" onClick={() => onOpenSessions()}>
            {localized(language, "查看测试记录", "Browse test results")}
          </button>
        </div>
      </div>

      {data.status === "error" ? (
        <p className="testingStatusNote" role="status">
          {localized(
            language,
            "测试计划暂时无法加载，请稍后重试。",
            "Test plans could not be loaded right now. Please try again shortly."
          )}
        </p>
      ) : null}
      {data.status === "stale" ? (
        <p className="testingStatusNote" role="status">
          {localized(language, "显示的可能是较早的计划信息。", "What you see may be slightly out of date.")}
        </p>
      ) : null}

      {loading ? (
        <p className="testingEmpty">{localized(language, "正在加载测试计划…", "Loading test plans…")}</p>
      ) : activePlans.length ? (
        <div className="testingPlanList">{activePlans.map((run) => renderPlan(run))}</div>
      ) : (
        <p className="testingEmpty">
          {isTester
            ? localized(
                language,
                "还没有分配给你的测试任务。你可以随时开始自由语音测试。",
                "No test tasks assigned to you yet. You can still start a free voice test any time."
              )
            : localized(language, "还没有测试计划。", "There are no test plans yet.")}
        </p>
      )}

      {archivedPlans.length ? (
        <details className="testingPlansArchived">
          <summary>
            {localized(language, `已归档的计划（${archivedPlans.length}）`, `Archived plans (${archivedPlans.length})`)}
          </summary>
          <ul className="testingArchivedList">
            {archivedPlans.map((run) => (
              <li key={run.id}>
                <strong>{run.name}</strong>
                <span>
                  {testingRunStatusLabel(run.status, language)} · {localized(language, "更新于", "Updated")}{" "}
                  {formatAdminRelativeTime(run.updatedAt, language)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
