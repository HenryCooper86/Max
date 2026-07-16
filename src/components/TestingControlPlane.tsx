import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TesterSessionSummary } from "../../shared/agent";
import {
  TESTING_TEST_CASES,
  type TestingOperationsSnapshot,
  type TestingPolicy,
  type TestingReview,
  type TestingReviewSeverity,
  type TestingReviewStatus,
  type TestingRun,
  type TestingRunStatus
} from "../../shared/testing";
import type { AuthUser } from "../lib/auth";
import {
  createTestingAssignment,
  createTestingPolicy,
  createTestingRun,
  fetchTestingOperations,
  fetchTestingRuns,
  saveTestingReview,
  updateTestingRun
} from "../lib/testing-api";
import { formatRelativeTime } from "../lib/utils";

type ControlTab = "runs" | "issues" | "policy" | "audit";

type Props = {
  user: AuthUser;
  currentBuild: string;
  selectedSession?: TesterSessionSummary;
  onSelectSession: (sessionId: string) => void;
  onUseAssignment: (runId: string, assignmentId: string, testCaseId: string) => void;
};

const RUN_STATUSES: TestingRunStatus[] = ["draft", "active", "blocked", "ready", "approved", "archived"];
const REVIEW_STATUSES: TestingReviewStatus[] = ["open", "triaged", "resolved", "waived"];
const REVIEW_SEVERITIES: TestingReviewSeverity[] = ["low", "medium", "high", "critical"];

function caseName(testCaseId: string) {
  return TESTING_TEST_CASES.find((item) => item.id === testCaseId)?.name ?? testCaseId;
}

function runProgress(run: TestingRun) {
  const required = run.requirements.reduce((sum, requirement) => sum + requirement.requiredValidSessions, 0);
  const completed = run.assignments.reduce((sum, assignment) => sum + assignment.completedSessionIds.length, 0);
  return { required, completed, percent: required ? Math.min(100, Math.round((completed / required) * 100)) : 0 };
}

function detailSummary(detail: Record<string, unknown>) {
  const entries = Object.entries(detail).slice(0, 3);
  return entries.length ? entries.map(([key, value]) => `${key}: ${String(value)}`).join(" · ") : "No extra detail";
}

export function TestingControlPlane({ user, currentBuild, selectedSession, onSelectSession, onUseAssignment }: Props) {
  const isReviewer = user.role === "admin" || user.role === "reviewer";
  const [tab, setTab] = useState<ControlTab>("runs");
  const [operations, setOperations] = useState<TestingOperationsSnapshot | null>(null);
  const [policies, setPolicies] = useState<TestingPolicy[]>([]);
  const [testerRuns, setTesterRuns] = useState<TestingRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [runName, setRunName] = useState("");
  const [runBuild, setRunBuild] = useState(currentBuild);
  const [runOwner, setRunOwner] = useState(user.username);
  const [runDueDate, setRunDueDate] = useState("");
  const [assignee, setAssignee] = useState(user.username);
  const [reviewTitle, setReviewTitle] = useState("Session requires review");
  const [reviewComment, setReviewComment] = useState("");
  const [reviewSeverity, setReviewSeverity] = useState<TestingReviewSeverity>("medium");
  const [reviewOwner, setReviewOwner] = useState(user.username);
  const [policyDescription, setPolicyDescription] = useState("");
  const [policyLatency, setPolicyLatency] = useState(800);
  const [policyInvalid, setPolicyInvalid] = useState(0);
  const [policySafetySamples, setPolicySafetySamples] = useState(3);
  const policyInitializedRef = useRef(false);
  const reviewDraftKeyRef = useRef("");

  const refresh = useCallback(async () => {
    if (isReviewer) {
      const payload = await fetchTestingOperations();
      if (!payload) {
        setNotice("QA control plane could not be loaded. Your session may have expired.");
        return;
      }
      setOperations(payload.operations);
      setPolicies(payload.policies);
      setSelectedRunId((current) => current ?? payload.operations.runs[0]?.id ?? null);
      if (!policyInitializedRef.current) {
        policyInitializedRef.current = true;
        setPolicyLatency(payload.operations.activePolicy.release.maxP95LatencyMs);
        setPolicyInvalid(payload.operations.activePolicy.release.maxInvalidSessions);
        setPolicySafetySamples(payload.operations.activePolicy.release.minSafetyCriticalSessions);
      }
      return;
    }
    const runs = await fetchTestingRuns();
    if (!runs) {
      setNotice("Assigned release work could not be loaded.");
      return;
    }
    setTesterRuns(runs);
    setSelectedRunId((current) => current ?? runs[0]?.id ?? null);
  }, [isReviewer]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 20_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => setRunBuild(currentBuild), [currentBuild]);

  const runs = isReviewer ? (operations?.runs ?? []) : testerRuns;
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? runs[0];
  const openReviews = useMemo(
    () => (operations?.reviews ?? []).filter((review) => review.status === "open" || review.status === "triaged"),
    [operations]
  );
  const selectedReview = selectedSession
    ? (operations?.reviews ?? []).find(
        (review) =>
          review.sessionId === selectedSession.sessionId && (review.status === "open" || review.status === "triaged")
      )
    : undefined;

  useEffect(() => {
    const sessionId = selectedSession?.sessionId;
    if (!sessionId) return;
    const key = `${sessionId}:${selectedReview?.id ?? "new"}`;
    if (reviewDraftKeyRef.current === key) return;
    reviewDraftKeyRef.current = key;
    setReviewTitle(selectedReview?.title ?? "Session requires review");
    setReviewComment(selectedReview?.comment ?? "");
    setReviewSeverity(selectedReview?.severity ?? "medium");
    setReviewOwner(selectedReview?.owner ?? user.username);
  }, [selectedReview, selectedSession?.sessionId, user.username]);

  const createRun = async () => {
    setBusy(true);
    setNotice(null);
    const run = await createTestingRun({
      name: runName.trim() || `Release ${runBuild}`,
      build: runBuild.trim() || currentBuild,
      owner: runOwner.trim() || user.username,
      dueAt: runDueDate ? new Date(`${runDueDate}T23:59:59`).getTime() : undefined
    });
    if (run) {
      setRunName("");
      setSelectedRunId(run.id);
      setNotice(`Release run “${run.name}” created with ${run.requirements.length} coverage requirements.`);
      await refresh();
    } else {
      setNotice("Release run could not be created.");
    }
    setBusy(false);
  };

  const changeRunStatus = async (run: TestingRun, status: TestingRunStatus) => {
    setBusy(true);
    setNotice(null);
    const updated = await updateTestingRun(run.id, { status });
    setNotice(
      updated
        ? `Run status changed to ${updated.status}.`
        : status === "approved"
          ? "Approval was blocked. The release gate, evidence coverage, open reviews, and approver role must all pass."
          : "Run status could not be changed."
    );
    await refresh();
    setBusy(false);
  };

  const assignRequirement = async (run: TestingRun, requirementId: string) => {
    setBusy(true);
    const updated = await createTestingAssignment(run.id, requirementId, assignee.trim() || user.username);
    setNotice(
      updated ? `Coverage task assigned to ${assignee.trim() || user.username}.` : "Assignment could not be created."
    );
    await refresh();
    setBusy(false);
  };

  const submitReview = async () => {
    if (!selectedSession) return;
    setBusy(true);
    const review = await saveTestingReview({
      id: selectedReview?.id,
      sessionId: selectedSession.sessionId,
      runId: selectedSession.runId,
      status: selectedReview?.status ?? "open",
      severity: reviewSeverity,
      owner: reviewOwner.trim() || user.username,
      title: reviewTitle.trim() || "Session requires review",
      comment: reviewComment.trim()
    });
    setNotice(review ? "Review saved to the durable issue queue." : "Review could not be saved.");
    await refresh();
    setBusy(false);
  };

  const changeReviewStatus = async (review: TestingReview, status: TestingReviewStatus) => {
    setBusy(true);
    const updated = await saveTestingReview({
      ...review,
      status,
      resolution: status === "resolved" ? "Reviewed" : review.resolution
    });
    setNotice(updated ? `Review marked ${status}.` : "Review could not be updated.");
    await refresh();
    setBusy(false);
  };

  // A cleared number input parses to 0 (Number("") === 0). The server clamps these
  // to their floors, so publishing a blank field would silently ship the minimum
  // rather than what the admin intended — block publish until the fields are in range.
  const policyFieldsValid =
    Number.isFinite(policyLatency) &&
    policyLatency >= 100 &&
    Number.isFinite(policyInvalid) &&
    policyInvalid >= 0 &&
    Number.isFinite(policySafetySamples) &&
    policySafetySamples >= 1;

  const publishPolicy = async () => {
    const active = operations?.activePolicy;
    if (!active || !policyFieldsValid) return;
    setBusy(true);
    const next = await createTestingPolicy({
      ...active,
      version: `${new Date().toISOString().slice(0, 10)}.${Date.now()}`,
      description: policyDescription.trim() || "Updated from the QA control plane.",
      release: {
        ...active.release,
        maxP95LatencyMs: policyLatency,
        maxInvalidSessions: policyInvalid,
        minSafetyCriticalSessions: policySafetySamples
      }
    });
    setNotice(next ? `Policy ${next.version} is now active.` : "Policy could not be published.");
    if (next) setPolicyDescription("");
    await refresh();
    setBusy(false);
  };

  return (
    <section className="testingControlPlane" aria-label="QA control plane">
      <div className="controlPlaneHead">
        <div>
          <span>Live-agent QA control plane</span>
          <strong>{isReviewer ? "Release operations" : "My assigned coverage"}</strong>
        </div>
        <nav className="controlPlaneTabs" aria-label="QA operations views">
          {(["runs", ...(isReviewer ? ["issues", "policy", "audit"] : [])] as ControlTab[]).map((item) => (
            <button key={item} type="button" className={tab === item ? "active" : ""} onClick={() => setTab(item)}>
              {item === "runs"
                ? "Release runs"
                : item === "issues"
                  ? `Issues ${openReviews.length}`
                  : item === "policy"
                    ? "Policy"
                    : "Audit"}
            </button>
          ))}
        </nav>
      </div>

      {notice ? (
        <p className="adminNotice" role="status">
          {notice}
        </p>
      ) : null}

      {tab === "runs" ? (
        <div className="controlPlaneBody">
          {isReviewer ? (
            <div className="runCreateBar">
              <label>
                <span>Run name</span>
                <input
                  value={runName}
                  onChange={(event) => setRunName(event.target.value)}
                  placeholder="July release candidate"
                />
              </label>
              <label>
                <span>Build</span>
                <input value={runBuild} onChange={(event) => setRunBuild(event.target.value)} />
              </label>
              <label>
                <span>Owner</span>
                <input value={runOwner} onChange={(event) => setRunOwner(event.target.value)} />
              </label>
              <label>
                <span>Due</span>
                <input type="date" value={runDueDate} onChange={(event) => setRunDueDate(event.target.value)} />
              </label>
              <button type="button" disabled={busy} onClick={() => void createRun()}>
                Create run
              </button>
            </div>
          ) : null}

          <div className="releaseRunGrid">
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
                    <span>{run.status}</span>
                    <strong>{run.name}</strong>
                    <small>
                      {run.build} · {progress.completed}/{progress.required} samples
                    </small>
                    <i>
                      <b style={{ width: `${progress.percent}%` }} />
                    </i>
                  </button>
                );
              })}
              {!runs.length ? <p className="testerConversationEmpty">No release runs are assigned yet.</p> : null}
            </div>

            <div className="releaseRunDetail">
              {selectedRun ? (
                <>
                  <div className="releaseRunTitle">
                    <div>
                      <span>{selectedRun.build}</span>
                      <strong>{selectedRun.name}</strong>
                      <p>
                        Owner {selectedRun.owner} · policy {selectedRun.policyVersion}
                      </p>
                    </div>
                    {isReviewer ? (
                      <select
                        value={selectedRun.status}
                        disabled={busy}
                        onChange={(event) => void changeRunStatus(selectedRun, event.target.value as TestingRunStatus)}
                      >
                        {RUN_STATUSES.filter(
                          (status) => status === selectedRun.status || status !== "approved" || user.role === "admin"
                        ).map((status) => (
                          <option key={status} value={status} disabled={status === "approved" && user.role !== "admin"}>
                            {status}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className={`runStatus ${selectedRun.status}`}>{selectedRun.status}</span>
                    )}
                  </div>
                  {isReviewer ? (
                    <label className="assignmentOwner">
                      <span>Assign new tasks to</span>
                      <input
                        value={assignee}
                        onChange={(event) => setAssignee(event.target.value)}
                        placeholder="tester username"
                      />
                    </label>
                  ) : null}
                  <div className="coverageMatrix">
                    {selectedRun.requirements.map((requirement) => {
                      const assignments = selectedRun.assignments.filter(
                        (item) => item.requirementId === requirement.id
                      );
                      const completed = assignments.reduce((sum, item) => sum + item.completedSessionIds.length, 0);
                      const mine = assignments.find(
                        (item) => item.assignee === user.username && item.status !== "complete"
                      );
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
                            {completed}/{requirement.requiredValidSessions} evidence samples
                          </p>
                          <div className="coverageAssignments">
                            {assignments.map((item) => (
                              <span key={item.id}>
                                {item.assignee} · {item.status}
                              </span>
                            ))}
                          </div>
                          {isReviewer ? (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void assignRequirement(selectedRun, requirement.id)}
                            >
                              Assign
                            </button>
                          ) : mine && (mine.platform === "web" || mine.platform === "unknown") ? (
                            <button
                              type="button"
                              onClick={() => onUseAssignment(selectedRun.id, mine.id, mine.testCaseId)}
                            >
                              Use in next session
                            </button>
                          ) : mine ? (
                            <small>Open the {mine.platform} client to capture this task.</small>
                          ) : null}
                        </article>
                      );
                    })}
                  </div>
                </>
              ) : (
                <p className="testerConversationEmpty">Select or create a release run.</p>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {tab === "issues" && isReviewer ? (
        <div className="issueWorkbench">
          <div className="reviewComposer">
            <span>Selected evidence</span>
            <strong>
              {selectedSession
                ? `${selectedSession.testCaseName} · ${selectedSession.testerId}`
                : "Select a session below"}
            </strong>
            <div className="reviewFields">
              <label>
                <span>Severity</span>
                <select
                  value={reviewSeverity}
                  onChange={(event) => setReviewSeverity(event.target.value as TestingReviewSeverity)}
                >
                  {REVIEW_SEVERITIES.map((severity) => (
                    <option key={severity}>{severity}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Owner</span>
                <input value={reviewOwner} onChange={(event) => setReviewOwner(event.target.value)} />
              </label>
              <label className="wide">
                <span>Title</span>
                <input value={reviewTitle} onChange={(event) => setReviewTitle(event.target.value)} />
              </label>
              <label className="wide">
                <span>Reviewer comment</span>
                <textarea
                  value={reviewComment}
                  onChange={(event) => setReviewComment(event.target.value)}
                  placeholder="Reproduction, expected behavior, disposition…"
                />
              </label>
            </div>
            <button type="button" disabled={busy || !selectedSession} onClick={() => void submitReview()}>
              {selectedReview ? "Update review" : "Open review"}
            </button>
          </div>
          <div className="reviewQueue">
            {(operations?.reviews ?? []).map((review) => (
              <article key={review.id} className={`reviewRow ${review.severity}`}>
                <button type="button" className="reviewEvidenceLink" onClick={() => onSelectSession(review.sessionId)}>
                  <span>
                    {review.severity} · {review.status}
                  </span>
                  <strong>{review.title}</strong>
                  <small>
                    {review.owner} · {formatRelativeTime(review.updatedAt)}
                  </small>
                </button>
                <p>{review.comment || "No reviewer comment."}</p>
                <select
                  value={review.status}
                  disabled={busy}
                  onChange={(event) => void changeReviewStatus(review, event.target.value as TestingReviewStatus)}
                >
                  {REVIEW_STATUSES.map((status) => (
                    <option key={status}>{status}</option>
                  ))}
                </select>
              </article>
            ))}
            {!operations?.reviews.length ? (
              <p className="testerConversationEmpty">The durable issue queue is clear.</p>
            ) : null}
          </div>
        </div>
      ) : null}

      {tab === "policy" && isReviewer ? (
        <div className="policyWorkbench">
          <div className="activePolicyCard">
            <span>Active policy</span>
            <strong>{operations?.activePolicy.version ?? "—"}</strong>
            <p>{operations?.activePolicy.description}</p>
            <small>Approved baseline: {operations?.approvedBaselineBuild ?? "not selected"}</small>
          </div>
          <div className="policyFields">
            <label>
              <span>Max release p95 (ms)</span>
              <input
                type="number"
                min="100"
                value={policyLatency}
                onChange={(event) => setPolicyLatency(Number(event.target.value))}
                disabled={user.role !== "admin"}
              />
            </label>
            <label>
              <span>Allowed invalid evidence</span>
              <input
                type="number"
                min="0"
                value={policyInvalid}
                onChange={(event) => setPolicyInvalid(Number(event.target.value))}
                disabled={user.role !== "admin"}
              />
            </label>
            <label>
              <span>Safety samples / case</span>
              <input
                type="number"
                min="1"
                value={policySafetySamples}
                onChange={(event) => setPolicySafetySamples(Number(event.target.value))}
                disabled={user.role !== "admin"}
              />
            </label>
            <label className="wide">
              <span>Change rationale</span>
              <textarea
                value={policyDescription}
                onChange={(event) => setPolicyDescription(event.target.value)}
                disabled={user.role !== "admin"}
              />
            </label>
            {user.role === "admin" ? (
              <button
                type="button"
                disabled={busy || !policyDescription.trim() || !policyFieldsValid}
                onClick={() => void publishPolicy()}
              >
                Publish versioned policy
              </button>
            ) : (
              <p>Policy changes require an administrator; reviewers have read-only access.</p>
            )}
          </div>
          <div className="policyHistory">
            {policies.map((policy) => (
              <span key={policy.version} className={policy.active ? "active" : ""}>
                <b>{policy.version}</b>
                {policy.createdBy} · {formatRelativeTime(policy.createdAt)}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {tab === "audit" && isReviewer ? (
        <div className="auditTimeline">
          {(operations?.audit ?? []).map((event) => (
            <article key={event.id}>
              <time>{formatRelativeTime(event.at)}</time>
              <div>
                <strong>{event.action}</strong>
                <span>
                  {event.actor} · {event.targetType} · {event.targetId}
                </span>
                <p>{detailSummary(event.detail)}</p>
              </div>
            </article>
          ))}
          {!operations?.audit.length ? (
            <p className="testerConversationEmpty">No operational changes have been recorded yet.</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
