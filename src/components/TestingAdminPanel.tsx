// The QA admin panel: per-tester statistics, timeline charts, chat-history
// drilldown, session replay with deterministic evaluation, exports — and the
// admin actions (clear one tester, delete one session, clear everything).
// Destructive actions use a two-step arm/confirm instead of a blocking dialog.

import { useCallback, useEffect, useState } from "react";
import { scenarioLabel } from "../../shared/ride";
import { TESTING_CAMPAIGNS, TESTING_TEST_CASES, defaultTestCaseForCampaign } from "../../shared/testing";
import type { HelmetAgent } from "../hooks/useHelmetAgent";
import type { AuthUser } from "../lib/auth";
import { relayAuthToken } from "../lib/persistence";
import { AccountAdmin } from "./AccountAdmin";
import { AccountBar } from "./AccountBar";
import {
  currentTesterSnapshot,
  exportTestingReport,
  exportTestingSession,
  formatBytes,
  formatClockTime,
  formatDuration,
  formatRelativeTime,
  requestTestingClear,
  type TestingClearScope
} from "../lib/utils";

const TEST_QUALITY_FILTERS = ["all", "pass", "watch", "fail"] as const;
type TestQualityFilter = (typeof TEST_QUALITY_FILTERS)[number];

function testQualityLabel(quality: TestQualityFilter) {
  if (quality === "all") return "All";
  if (quality === "pass") return "Pass";
  if (quality === "watch") return "Watch";
  return "Fail";
}

function testQualityClass(quality: "pass" | "watch" | "fail") {
  return quality === "pass" ? "good" : quality === "watch" ? "warn" : "alert";
}

function formatSessionDate(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(timestamp);
}

function barHeight(value: number, max: number) {
  if (!Number.isFinite(value) || value <= 0 || max <= 0) return "3%";
  return `${Math.max(6, Math.round((value / max) * 100))}%`;
}

// "New failures" watermark: fail sessions that ended after this timestamp
// count as unseen. Local to this browser — it tracks what THIS admin has
// looked at, not global state.
const FAIL_SEEN_AT_KEY = "max.testing.failSeenAt";

function readFailSeenAt(): number {
  try {
    const value = Number(window.localStorage.getItem(FAIL_SEEN_AT_KEY));
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function saveFailSeenAt(at: number) {
  try {
    window.localStorage.setItem(FAIL_SEEN_AT_KEY, String(at));
  } catch {
    /* storage unavailable — badge just stays until next visit */
  }
}

type Props = {
  agent: HelmetAgent;
  /** Auth state lives in App — the LoginGate and this panel share it. */
  authUser: AuthUser | null;
  onSignedIn: (user: AuthUser) => void;
  onSignedOut: () => void;
};

export function TestingAdminPanel({ agent, authUser, onSignedIn, onSignedOut }: Props) {
  const [selectedTesterKey, setSelectedTesterKey] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [testerFilter, setTesterFilter] = useState("");
  const [qualityFilter, setQualityFilter] = useState<TestQualityFilter>("all");
  // Two-step confirm for destructive actions: first click arms the button,
  // the second within the window executes; anything else disarms.
  const [armedAction, setArmedAction] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [adminNotice, setAdminNotice] = useState<string | null>(null);
  const [failSeenAt, setFailSeenAt] = useState(readFailSeenAt);

  useEffect(() => {
    if (!armedAction) return;
    const timer = window.setTimeout(() => setArmedAction(null), 4000);
    return () => window.clearTimeout(timer);
  }, [armedAction]);

  const runClear = useCallback(
    async (payload: TestingClearScope) => {
      setClearing(true);
      setAdminNotice(null);
      const ok = await requestTestingClear(payload);
      if (ok) {
        setSelectedSessionId(null);
        if (payload.scope !== "session") setSelectedTesterKey(null);
        await agent.refreshHealth();
      } else {
        setAdminNotice("清除失败 — 需要管理员登录（或有效的中继令牌），并确认中继在线。");
      }
      setClearing(false);
    },
    [agent]
  );

  const confirmable = useCallback(
    (key: string, action: () => void) => {
      if (armedAction === key) {
        setArmedAction(null);
        action();
      } else {
        setArmedAction(key);
      }
    },
    [armedAction]
  );

  const testing = agent.health?.testing;
  const testingTotals = testing?.totals;
  const testingTimeline = testing?.timeline ?? [];
  // Guard against a relay shipping an empty catalog: selectedCampaign.id
  // below must never dereference undefined.
  const testingCampaigns = testing?.catalog?.campaigns?.length ? testing.catalog.campaigns : TESTING_CAMPAIGNS;
  const testingTestCases = testing?.catalog?.testCases?.length ? testing.catalog.testCases : TESTING_TEST_CASES;
  const selectedCampaign =
    testingCampaigns.find((campaign) => campaign.id === agent.testingCampaignId) ?? testingCampaigns[0];
  const selectedTestCase =
    testingTestCases.find((testCase) => testCase.id === agent.testingTestCaseId) ??
    defaultTestCaseForCampaign(selectedCampaign.id);
  const testCasesForCampaign = testingTestCases.filter((testCase) => testCase.campaignId === selectedCampaign.id);
  const testerUsers = testing?.users ?? [];
  const testingSessions = testing?.sessions ?? [];
  const currentTester = currentTesterSnapshot(agent.health, agent.testerId);
  const selectedTester =
    (selectedTesterKey ? testerUsers.find((user) => user.testerKey === selectedTesterKey) : undefined) ??
    currentTester ??
    testerUsers[0];
  const selectedTesterTurns = selectedTester?.recentTurns ?? [];
  const normalizedTesterFilter = testerFilter.trim().toLowerCase();
  const filteredTesterUsers = testerUsers.filter((user) => {
    if (!normalizedTesterFilter) return true;
    return `${user.testerId} ${user.ipAddress} ${user.region}`.toLowerCase().includes(normalizedTesterFilter);
  });
  const selectedTesterSessions = selectedTester
    ? testingSessions.filter((session) => session.testerKey === selectedTester.testerKey)
    : testingSessions;
  const filteredTestingSessions = selectedTesterSessions.filter(
    (session) => qualityFilter === "all" || session.quality === qualityFilter
  );
  const selectedSession =
    (selectedSessionId
      ? filteredTestingSessions.find((session) => session.sessionId === selectedSessionId)
      : undefined) ?? filteredTestingSessions[0];
  const selectedSessionTurns = selectedSession?.turns ?? [];
  const totalDownBytes = (testingTotals?.audioDownBytes ?? 0) + (testingTotals?.controlDownBytes ?? 0);
  const totalBandwidthBytes = (testingTotals?.audioUpBytes ?? 0) + totalDownBytes;
  const maxBandwidthBucket = Math.max(
    1,
    ...testingTimeline.map((bucket) => bucket.audioUpBytes + bucket.audioDownBytes + bucket.controlDownBytes)
  );
  const maxLatencyBucket = Math.max(1, ...testingTimeline.map((bucket) => bucket.avgLatencyMs));
  const qualityTone =
    (testingTotals?.errorEvents ?? 0) > 0 || (testingTotals?.p95LatencyMs ?? 0) > 800
      ? "alert"
      : (testingTotals?.p95LatencyMs ?? 0) > 320 || (testingTotals?.ttsFallbacks ?? 0) > 0
        ? "warn"
        : "good";
  const selectTester = (testerKey: string) => {
    setSelectedTesterKey(testerKey);
    setSelectedSessionId(null);
  };
  // Failures the admin hasn't looked at yet (across ALL testers, ignoring the
  // current tester/quality filters — a fail must not hide behind a filter).
  const unseenFailSessions = testingSessions.filter(
    (session) => session.quality === "fail" && session.endedAt > failSeenAt
  );
  const reviewFailures = () => {
    // Jump straight to the newest unseen failure (the session list is scoped
    // to one tester, so also select that session's tester).
    const newest = [...unseenFailSessions].sort((a, b) => b.endedAt - a.endedAt)[0];
    if (newest) {
      setSelectedTesterKey(newest.testerKey);
      setSelectedSessionId(newest.sessionId);
    }
    setQualityFilter("fail");
    const latest = Math.max(failSeenAt, ...unseenFailSessions.map((session) => session.endedAt));
    setFailSeenAt(latest);
    saveFailSeenAt(latest);
  };
  const authEnabled = agent.health?.auth?.enabled ?? false;
  const registrationOpen = agent.health?.auth?.registrationOpen ?? true;
  // Once accounts exist, the relay refuses non-admin clears; mirror that in
  // the UI. The relay token only helps when it is what we actually SEND —
  // requests carry the login session first (see credentialToken), so a
  // logged-in tester cannot clear even with a relay token stored.
  const canClear = !authEnabled || authUser?.role === "admin" || (!authUser && Boolean(relayAuthToken()));
  const statsLocked = Boolean(agent.health) && authEnabled && !testing;

  return (
    <section className="hudPanel testingPanel" aria-label="测试统计与管理">
      <div className="panelHeader">
        <h2>测试统计</h2>
        <div className="panelActions">
          <span>
            {testing ? `${testing.windowMinutes}m · ${testing.users.length} users` : "waiting"}
            {agent.health?.build ? ` · 构建 ${agent.health.build.gitCommit}` : ""}
          </span>
          {unseenFailSessions.length ? (
            <button type="button" className="danger" onClick={reviewFailures}>
              {unseenFailSessions.length} 个新失败
            </button>
          ) : null}
          <button type="button" onClick={() => exportTestingReport(agent.health, agent.testerId, agent.testerRegion)}>
            导出统计
          </button>
          <button
            type="button"
            className={`danger ${armedAction === "clear-all" ? "armed" : ""}`}
            disabled={clearing || !testerUsers.length || !canClear}
            title={canClear ? undefined : "需要管理员登录"}
            onClick={() => confirmable("clear-all", () => void runClear({ scope: "all" }))}
          >
            {armedAction === "clear-all" ? "确认清除全部?" : "清除全部"}
          </button>
        </div>
      </div>

      <AccountBar
        authEnabled={authEnabled}
        registrationOpen={registrationOpen}
        user={authUser}
        onSignedIn={onSignedIn}
        onSignedOut={onSignedOut}
      />

      {authUser?.role === "admin" ? <AccountAdmin adminUsername={authUser.username} /> : null}

      {statsLocked ? (
        <p className="adminNotice" role="status">
          测试统计已启用账号保护 — 登录后查看测试员数据、会话回放与聊天记录。
        </p>
      ) : null}

      {adminNotice ? (
        <p className="adminNotice" role="alert">
          {adminNotice}
        </p>
      ) : null}

      <div className="testerBar">
        <label>
          <span>Tester ID</span>
          <input
            value={agent.testerId}
            onChange={(event) => agent.setTesterId(event.target.value)}
            placeholder="tester-name"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <div className={`testQuality ${qualityTone}`}>
          <span>质量</span>
          <strong>{qualityTone === "good" ? "PASS" : qualityTone === "warn" ? "WATCH" : "FAIL"}</strong>
        </div>
        <div>
          <span>当前测试员</span>
          <strong>{currentTester ? `${currentTester.totalSessions} sessions` : "new"}</strong>
        </div>
        <div>
          <span>IP / Region</span>
          <strong>
            {currentTester ? `${currentTester.ipAddress} · ${currentTester.region}` : `pending · ${agent.testerRegion}`}
          </strong>
        </div>
      </div>

      <div className="testingWorkflowBar">
        <label>
          <span>Campaign</span>
          <select value={agent.testingCampaignId} onChange={(event) => agent.setTestingCampaignId(event.target.value)}>
            {testingCampaigns.map((campaign) => (
              <option key={campaign.id} value={campaign.id}>
                {campaign.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Test case</span>
          <select value={agent.testingTestCaseId} onChange={(event) => agent.setTestingTestCaseId(event.target.value)}>
            {testCasesForCampaign.map((testCase) => (
              <option key={testCase.id} value={testCase.id}>
                {testCase.name}
              </option>
            ))}
          </select>
        </label>
        <div className="testCaseBrief">
          <span>{selectedTestCase.id}</span>
          <strong>{selectedTestCase.description}</strong>
          <p>
            {scenarioLabel(selectedTestCase.scenario)} · {selectedTestCase.rideMode} · p95 ≤{" "}
            {selectedTestCase.maxP95LatencyMs}ms
          </p>
        </div>
      </div>

      <div className="testingFilterBar">
        <label>
          <span>Find tester</span>
          <input
            value={testerFilter}
            onChange={(event) => setTesterFilter(event.target.value)}
            placeholder="ID, IP, or region"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <div className="qualityFilter" role="group" aria-label="Session quality filter">
          {TEST_QUALITY_FILTERS.map((quality) => (
            <button
              key={quality}
              type="button"
              className={qualityFilter === quality ? "active" : ""}
              aria-pressed={qualityFilter === quality}
              onClick={() => {
                setQualityFilter(quality);
                setSelectedSessionId(null);
              }}
            >
              {testQualityLabel(quality)}
            </button>
          ))}
        </div>
        <div className="historyRetention">
          <span>History</span>
          <strong>
            {testing?.history.persistent ? "persistent" : "memory"} · {testing?.sessions.length ?? 0}/
            {testing?.history.maxSessions ?? 0}
          </strong>
        </div>
      </div>

      <div className="statGrid">
        <span>
          <b>{testingTotals?.activeTestSessions ?? agent.health?.metrics?.activeSessions ?? 0}</b>
          Active
        </span>
        <span>
          <b>{testingTotals?.totalTestSessions ?? 0}</b>
          Sessions
        </span>
        <span>
          <b>{formatBytes(testingTotals?.audioUpBytes ?? 0)}</b>
          Mic up
        </span>
        <span>
          <b>{formatBytes(totalDownBytes)}</b>
          Downlink
        </span>
        <span>
          <b>{testingTotals?.avgLatencyMs ?? 0}ms</b>
          Avg first audio
        </span>
        <span>
          <b>{testingTotals?.p95LatencyMs ?? 0}ms</b>
          P95
        </span>
        <span>
          <b>{testingTotals?.errorEvents ?? 0}</b>
          Errors
        </span>
        <span>
          <b>{testingTotals?.ttsFallbacks ?? 0}</b>
          TTS fallback
        </span>
      </div>

      <div className="chartGrid">
        <div className="chartBlock">
          <div className="instrumentHead">
            <span>Bandwidth</span>
            <b>{formatBytes(totalBandwidthBytes)}</b>
          </div>
          <div className="miniChart" aria-label="最近带宽趋势">
            {testingTimeline.map((bucket) => {
              const bytes = bucket.audioUpBytes + bucket.audioDownBytes + bucket.controlDownBytes;
              return (
                <i
                  key={bucket.at}
                  style={{ height: barHeight(bytes, maxBandwidthBucket) }}
                  title={`${formatClockTime(bucket.at)} · ${formatBytes(bytes)}`}
                />
              );
            })}
          </div>
          <div className="chartLegend">
            <span>up {formatBytes(testingTotals?.audioUpBytes ?? 0)}</span>
            <span>down {formatBytes(totalDownBytes)}</span>
          </div>
        </div>
        <div className="chartBlock">
          <div className="instrumentHead">
            <span>Latency</span>
            <b>{testingTotals?.p95LatencyMs ?? 0}ms p95</b>
          </div>
          <div className="miniChart latencyChart" aria-label="最近首音延迟趋势">
            {testingTimeline.map((bucket) => (
              <i
                key={bucket.at}
                style={{ height: barHeight(bucket.avgLatencyMs, maxLatencyBucket) }}
                title={`${formatClockTime(bucket.at)} · ${bucket.avgLatencyMs}ms`}
              />
            ))}
          </div>
          <div className="chartLegend">
            <span>{testingTimeline.reduce((sum, bucket) => sum + bucket.latencySamples, 0)} samples</span>
            <span>{testingTotals?.errorEvents ?? 0} errors</span>
          </div>
        </div>
      </div>

      <div className="testerTableWrap">
        <table className="testerTable">
          <thead>
            <tr>
              <th>Tester</th>
              <th>IP / Region</th>
              <th>Runs</th>
              <th>Time</th>
              <th>Data</th>
              <th>Latency</th>
              <th>Last</th>
            </tr>
          </thead>
          <tbody>
            {filteredTesterUsers.length ? (
              filteredTesterUsers.map((user) => (
                <tr className={selectedTester?.testerKey === user.testerKey ? "selected" : ""} key={user.testerKey}>
                  <td>
                    <button className="testerLink" type="button" onClick={() => selectTester(user.testerKey)}>
                      <strong>{user.testerId}</strong>
                      <span>{user.activeSessions ? "active" : `${user.errorEvents} errors`}</span>
                    </button>
                  </td>
                  <td>
                    <button className="testerLink" type="button" onClick={() => selectTester(user.testerKey)}>
                      <strong>{user.ipAddress}</strong>
                      <span>{user.region}</span>
                    </button>
                  </td>
                  <td>{user.totalSessions}</td>
                  <td>{formatDuration(user.totalSessionMs)}</td>
                  <td>{formatBytes(user.audioUpBytes + user.audioDownBytes + user.controlDownBytes)}</td>
                  <td>
                    {user.avgLatencyMs}/{user.p95LatencyMs}ms
                  </td>
                  <td>{formatRelativeTime(user.lastSeenAt)}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={7}>{testerUsers.length ? "No testers match the filter" : "No test sessions yet"}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="testerConversationPanel">
        <div className="testerConversationHeader">
          <div>
            <span>Conversation history</span>
            <strong>{selectedTester?.testerId ?? "No tester selected"}</strong>
            {selectedTester ? (
              <p>
                {selectedTester.ipAddress} · {selectedTester.region} · {selectedTester.totalSessions} sessions ·{" "}
                {formatRelativeTime(selectedTester.lastSeenAt)}
              </p>
            ) : null}
          </div>
          <div className="testerConversationActions">
            <button
              type="button"
              onClick={() => {
                setSelectedTesterKey(currentTester?.testerKey ?? null);
                setSelectedSessionId(null);
              }}
              disabled={!currentTester}
            >
              Current tester
            </button>
            <button
              type="button"
              className={`danger ${armedAction === `clear-tester:${selectedTester?.testerKey}` ? "armed" : ""}`}
              disabled={clearing || !selectedTester || !canClear}
              title={canClear ? undefined : "需要管理员登录"}
              onClick={() =>
                selectedTester &&
                // The armed key carries the target: re-selection between arm
                // and confirm must never clear a different tester.
                confirmable(
                  `clear-tester:${selectedTester.testerKey}`,
                  () => void runClear({ scope: "tester", testerKey: selectedTester.testerKey })
                )
              }
            >
              {armedAction === `clear-tester:${selectedTester?.testerKey}` ? "确认清除?" : "清除此测试员"}
            </button>
          </div>
        </div>
        <div className="testerConversationList">
          {selectedTesterTurns.length ? (
            selectedTesterTurns.map((turn, index) => (
              <article
                className={`testerTurn ${turn.speaker}`}
                key={`${turn.sessionId}-${turn.at}-${turn.speaker}-${index}`}
              >
                <div>
                  <strong>{turn.speaker === "rider" ? "Rider" : "Max"}</strong>
                  <span>
                    {formatClockTime(turn.at)} · {turn.final ? "final" : "live"}
                  </span>
                  {turn.feedback ? <span className="turnFlagChip">⚑ {turn.feedback}</span> : null}
                </div>
                <p>{turn.text}</p>
              </article>
            ))
          ) : (
            <p className="testerConversationEmpty">No transcript captured yet.</p>
          )}
        </div>
      </div>

      <div className="testerSessionPanel">
        <div className="testerConversationHeader">
          <div>
            <span>Session replay</span>
            <strong>{selectedSession ? formatSessionDate(selectedSession.startedAt) : "No completed session"}</strong>
            {selectedSession ? (
              <p>
                {selectedSession.campaignName} · {selectedSession.testCaseName} ·{" "}
                {formatDuration(selectedSession.durationMs)}
              </p>
            ) : null}
          </div>
          <div className="testerConversationActions">
            <button
              type="button"
              onClick={() => selectedSession && exportTestingSession(selectedSession)}
              disabled={!selectedSession}
            >
              Export session
            </button>
            <button
              type="button"
              className={`danger ${armedAction === `clear-session:${selectedSession?.sessionId}` ? "armed" : ""}`}
              disabled={clearing || !selectedSession || !canClear}
              title={canClear ? undefined : "需要管理员登录"}
              onClick={() =>
                selectedSession &&
                confirmable(
                  `clear-session:${selectedSession.sessionId}`,
                  () => void runClear({ scope: "session", sessionId: selectedSession.sessionId })
                )
              }
            >
              {armedAction === `clear-session:${selectedSession?.sessionId}` ? "确认删除?" : "删除会话"}
            </button>
          </div>
        </div>
        <div className="sessionReplayGrid">
          <div className="sessionList" aria-label="Completed test sessions">
            {filteredTestingSessions.length ? (
              filteredTestingSessions.slice(0, 12).map((session) => (
                <button
                  className={`sessionButton ${selectedSession?.sessionId === session.sessionId ? "active" : ""}`}
                  key={session.sessionId}
                  type="button"
                  onClick={() => setSelectedSessionId(session.sessionId)}
                >
                  <span className={`sessionQuality ${testQualityClass(session.quality)}`}>
                    {testQualityLabel(session.quality)}
                  </span>
                  <strong>{formatSessionDate(session.startedAt)}</strong>
                  <span>
                    {formatDuration(session.durationMs)} · {session.turns.length} turns
                  </span>
                </button>
              ))
            ) : (
              <p className="testerConversationEmpty">No completed sessions match this view.</p>
            )}
          </div>
          <div className="sessionDetail">
            {selectedSession ? (
              <>
                <div className="sessionMetricGrid">
                  <span>
                    <b>{testQualityLabel(selectedSession.quality)}</b>
                    Quality
                  </span>
                  <span>
                    <b>{formatBytes(selectedSession.audioUpBytes)}</b>
                    Mic up
                  </span>
                  <span>
                    <b>{formatBytes(selectedSession.audioDownBytes + selectedSession.controlDownBytes)}</b>
                    Down
                  </span>
                  <span>
                    <b>
                      {selectedSession.avgLatencyMs}/{selectedSession.p95LatencyMs}ms
                    </b>
                    Avg / P95
                  </span>
                  <span>
                    <b>{selectedSession.errorEvents}</b>
                    Errors
                  </span>
                  <span>
                    <b>{selectedSession.ttsFallbacks}</b>
                    Fallbacks
                  </span>
                  <span>
                    <b>{selectedSession.evaluation.score}</b>
                    Eval score
                  </span>
                  <span>
                    <b>{selectedSession.deviceLabel}</b>
                    Device
                  </span>
                  <span>
                    <b>{selectedSession.networkType}</b>
                    Network
                  </span>
                  <span>
                    <b>
                      {selectedSession.appVersion} · {selectedSession.gitCommit}
                    </b>
                    Build
                  </span>
                </div>
                <div className="sessionFlags">
                  {selectedSession.flags.length ? (
                    selectedSession.flags.map((flag) => <span key={flag}>{flag}</span>)
                  ) : (
                    <span>clean run</span>
                  )}
                </div>
                <div className="evaluationList">
                  {selectedSession.evaluation.checks.map((check) => (
                    <div className={`evaluationCheck ${check.status}`} key={check.id}>
                      <strong>{check.label}</strong>
                      <span>{check.status}</span>
                      <p>{check.detail}</p>
                    </div>
                  ))}
                </div>
                <div className="sessionTranscriptList">
                  {selectedSessionTurns.length ? (
                    selectedSessionTurns.map((turn, index) => (
                      <article
                        className={`testerTurn ${turn.speaker}`}
                        key={`${turn.sessionId}-${turn.at}-${turn.speaker}-${index}`}
                      >
                        <div>
                          <strong>{turn.speaker === "rider" ? "Rider" : "Max"}</strong>
                          <span>
                            {formatClockTime(turn.at)} · {turn.final ? "final" : "live"}
                          </span>
                          {turn.feedback ? <span className="turnFlagChip">⚑ {turn.feedback}</span> : null}
                        </div>
                        <p>{turn.text}</p>
                      </article>
                    ))
                  ) : (
                    <p className="testerConversationEmpty">This session has no transcript turns.</p>
                  )}
                </div>
              </>
            ) : (
              <p className="testerConversationEmpty">Select a tester after completing a run to replay it here.</p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
