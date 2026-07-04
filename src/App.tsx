import { useCallback, useEffect, useMemo, useState } from "react";
import { HelmetVisual } from "./components/HelmetVisual";
import { SignalBars, WeatherReadout } from "./components/Instruments";
import { adasDirectionLabel } from "../shared/adas";
import { combineHazardLevels, scenarioLabel } from "../shared/ride";
import { TESTING_CAMPAIGNS, TESTING_TEST_CASES, defaultTestCaseForCampaign } from "../shared/testing";
import {
  CONNECTION_LABELS,
  CREDENTIAL_LABELS,
  HAZARD_ACTIONS,
  HAZARD_LABELS,
  NETWORK_LABELS,
  PERMISSION_LABELS,
  PERSONALITY_LABELS,
  RESPONSE_MODE_LABELS,
  RIDE_MODES,
  RIDE_MODE_LABELS,
  SAMPLE_RATE,
  SCENARIOS,
  UI_TEXT,
  VOICE_PERSONALITIES
} from "./lib/constants";
import {
  audioProcessingLabel,
  exportTestingSession,
  exportTestingReport,
  exportTranscriptLog,
  formatBytes,
  formatClockTime,
  formatDuration,
  formatRelativeTime
} from "./lib/utils";
import { useHelmetAgent } from "./hooks/useHelmetAgent";

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

export function App() {
  const agent = useHelmetAgent();
  const t = UI_TEXT[agent.sessionMemory.language];
  const [selectedTesterKey, setSelectedTesterKey] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [testerFilter, setTesterFilter] = useState("");
  const [qualityFilter, setQualityFilter] = useState<TestQualityFilter>("all");
  const { listening, starting, startMic, stopMic } = agent;

  // While a start is in flight (permission prompts, socket open) a second
  // press means "stop" — treating it as another start inverted the intent.
  const toggleHandsFreeSession = useCallback(() => {
    if (listening || starting) {
      stopMic();
    } else {
      void startMic();
    }
  }, [listening, starting, startMic, stopMic]);

  useEffect(() => {
    const toggleHandsFree = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName))
      ) {
        return;
      }

      event.preventDefault();
      toggleHandsFreeSession();
    };

    window.addEventListener("keydown", toggleHandsFree);
    return () => window.removeEventListener("keydown", toggleHandsFree);
  }, [toggleHandsFreeSession]);

  const agentState = useMemo(() => {
    if (agent.listening) return agent.sessionMemory.language === "en" ? "Hands-free" : "免提中";
    if (agent.connected) return agent.sessionMemory.language === "en" ? "Standby" : "待命";
    return agent.sessionMemory.language === "en" ? "Offline" : "离线";
  }, [agent.connected, agent.listening, agent.sessionMemory.language]);

  const latencyTone = agent.latencyMs < 140 ? "good" : agent.latencyMs < 280 ? "warn" : "alert";
  const lastCommand = [...agent.transcript].reverse().find((item) => item.speaker === "rider")?.text ?? "—";
  const lastReply = [...agent.transcript].reverse().find((item) => item.speaker === "agent")?.text ?? "—";
  const weatherRisk = agent.weather?.riskLevel ?? "normal";
  const fusedHazard = combineHazardLevels(agent.rideContext.hazardLevel, weatherRisk);
  const testing = agent.health?.testing;
  const testingTotals = testing?.totals;
  const testingTimeline = testing?.timeline ?? [];
  const testingCampaigns = testing?.catalog.campaigns ?? TESTING_CAMPAIGNS;
  const testingTestCases = testing?.catalog.testCases ?? TESTING_TEST_CASES;
  const selectedCampaign =
    testingCampaigns.find((campaign) => campaign.id === agent.testingCampaignId) ?? testingCampaigns[0];
  const selectedTestCase =
    testingTestCases.find((testCase) => testCase.id === agent.testingTestCaseId) ??
    defaultTestCaseForCampaign(selectedCampaign.id);
  const testCasesForCampaign = testingTestCases.filter((testCase) => testCase.campaignId === selectedCampaign.id);
  const testerUsers = testing?.users ?? [];
  const testingSessions = testing?.sessions ?? [];
  const currentTester = testerUsers
    .filter((user) => user.testerId === agent.testerId)
    .sort((a, b) => Number(b.activeSessions) - Number(a.activeSessions) || b.lastSeenAt - a.lastSeenAt)[0];
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
  const preflight = [
    { label: t.mic, value: PERMISSION_LABELS[agent.micPermission] },
    { label: t.location, value: PERMISSION_LABELS[agent.locationPermission] },
    { label: t.audio, value: `NS ${audioProcessingLabel(agent.audioProcessing.noiseSuppression)}` },
    { label: t.server, value: agent.health?.ok ? t.ready : "…" },
    { label: t.provider, value: agent.provider.toUpperCase() },
    {
      label: t.voice,
      value: `${agent.voiceGender === "female" ? "女声" : "男声"} · ${PERSONALITY_LABELS[agent.voicePersonality]}`
    }
  ];
  const selectTester = (testerKey: string) => {
    setSelectedTesterKey(testerKey);
    setSelectedSessionId(null);
  };

  return (
    <main className="shell">
      <section className="visor" aria-label="头盔语音助手座舱">
        <div className="topbar">
          <div className="brand">
            <svg className="logoMark" viewBox="0 0 44 44" aria-hidden="true">
              <path className="logoShell" d="M8 24a14 14 0 0 1 28 0v4a4 4 0 0 1-4 4H12a4 4 0 0 1-4-4Z" />
              <rect className="logoVisor" x="13" y="18" width="22" height="7" rx="3.5" />
            </svg>
            <div>
              <p className="eyebrow">HCT Helmet OS</p>
              <h1>Max 摩托车头盔 AI</h1>
            </div>
          </div>
          <div className="topbarControls">
            <div className="voiceToggle" role="group" aria-label="语音性别">
              <button
                type="button"
                className={agent.voiceGender === "female" ? "active" : ""}
                aria-pressed={agent.voiceGender === "female"}
                onClick={() => agent.setVoiceGender("female")}
              >
                女声
              </button>
              <button
                type="button"
                className={agent.voiceGender === "male" ? "active" : ""}
                aria-pressed={agent.voiceGender === "male"}
                onClick={() => agent.setVoiceGender("male")}
              >
                男声
              </button>
            </div>
            <div className="voiceToggle" role="group" aria-label="语气风格">
              {VOICE_PERSONALITIES.map((personality) => (
                <button
                  key={personality}
                  type="button"
                  className={agent.voicePersonality === personality ? "active" : ""}
                  aria-pressed={agent.voicePersonality === personality}
                  onClick={() => agent.setVoicePersonality(personality)}
                >
                  {PERSONALITY_LABELS[personality]}
                </button>
              ))}
            </div>
            <div className="modeToggle" role="group" aria-label="骑行模式">
              {RIDE_MODES.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={agent.rideContext.mode === mode ? "active" : ""}
                  aria-pressed={agent.rideContext.mode === mode}
                  onClick={() => agent.setRideMode(mode)}
                >
                  {RIDE_MODE_LABELS[mode]}
                </button>
              ))}
            </div>
            <div className={`signal ${agent.connected ? "online" : ""}`}>
              <span />
              {agent.provider.toUpperCase()}
            </div>
          </div>
        </div>

        {agent.hazardAlert && (
          <div className={`hazardBanner ${agent.hazardAlert.severity}`} role="alert" aria-live="assertive">
            <span className="hazardDir">{adasDirectionLabel(agent.hazardAlert.direction)}</span>
            <div className="hazardBody">
              <strong>⚠️ {agent.hazardAlert.label}</strong>
              <p>
                {agent.hazardAlert.message} {agent.hazardAlert.advice}
              </p>
            </div>
            <span className="hazardTtc">{agent.hazardAlert.ttcSeconds}s</span>
          </div>
        )}

        <div className="grid">
          <section className="hudPanel helmetPanel">
            <HelmetVisual
              connected={agent.connected}
              listening={agent.listening}
              voiceLevel={agent.voiceLevel}
              turnState={agent.turnState}
              hazardLevel={fusedHazard}
            />
            <div className="handsFree">
              <button
                className={`micButton ${agent.listening ? "active" : ""}`}
                aria-pressed={agent.listening}
                onClick={toggleHandsFreeSession}
                type="button"
              >
                {agent.listening ? "结束免提" : "开启免提"}
              </button>
              <p className="handsFreeHint">
                {agent.listening
                  ? "免提已开启 — 直接说话即可，按空格或点击按钮可结束。"
                  : "点击按钮或按空格开启免提。需要麦克风与定位权限。"}
              </p>
              <div className="scenarioStrip" aria-label="演示场景">
                {SCENARIOS.map((scenario) => (
                  <button
                    key={scenario}
                    type="button"
                    className={agent.rideContext.scenario === scenario ? "active" : ""}
                    aria-pressed={agent.rideContext.scenario === scenario}
                    onClick={() => agent.setScenario(scenario)}
                  >
                    {scenarioLabel(scenario)}
                  </button>
                ))}
                {agent.provider === "mock" && (
                  <button
                    type="button"
                    className={`guidedToggle ${agent.guidedDemo ? "active" : ""}`}
                    aria-pressed={agent.guidedDemo}
                    onClick={() => agent.setGuidedDemo(!agent.guidedDemo)}
                    title="自动巡游全部演示场景"
                  >
                    {agent.guidedDemo ? "■ 巡游中" : "▶ 巡游"}
                  </button>
                )}
              </div>
            </div>
          </section>

          <section className="hudPanel testingPanel" aria-label="测试统计">
            <div className="panelHeader">
              <h2>测试统计</h2>
              <div className="panelActions">
                <span>{testing ? `${testing.windowMinutes}m · ${testing.users.length} users` : "waiting"}</span>
                <button
                  type="button"
                  onClick={() => exportTestingReport(agent.health, agent.testerId, agent.testerRegion)}
                >
                  导出统计
                </button>
              </div>
            </div>

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
                  {currentTester
                    ? `${currentTester.ipAddress} · ${currentTester.region}`
                    : `pending · ${agent.testerRegion}`}
                </strong>
              </div>
            </div>

            <div className="testingWorkflowBar">
              <label>
                <span>Campaign</span>
                <select
                  value={agent.testingCampaignId}
                  onChange={(event) => agent.setTestingCampaignId(event.target.value)}
                >
                  {testingCampaigns.map((campaign) => (
                    <option key={campaign.id} value={campaign.id}>
                      {campaign.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Test case</span>
                <select
                  value={agent.testingTestCaseId}
                  onChange={(event) => agent.setTestingTestCaseId(event.target.value)}
                >
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
                      <tr
                        className={selectedTester?.testerKey === user.testerKey ? "selected" : ""}
                        key={user.testerKey}
                      >
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
                  <strong>
                    {selectedSession ? formatSessionDate(selectedSession.startedAt) : "No completed session"}
                  </strong>
                  {selectedSession ? (
                    <p>
                      {selectedSession.campaignName} · {selectedSession.testCaseName} ·{" "}
                      {formatDuration(selectedSession.durationMs)}
                    </p>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => selectedSession && exportTestingSession(selectedSession)}
                  disabled={!selectedSession}
                >
                  Export session
                </button>
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

          <section className="hudPanel statusPanel">
            <div className="stateBlock">
              <div className="stateMain">
                <p>{t.assistant}</p>
                <strong>{agentState}</strong>
              </div>
              <SignalBars active={agent.connected} />
            </div>
            <p className="stateDetail">{agent.status}</p>
            <div className={`instrument ridePulse ${fusedHazard}`}>
              <div className="instrumentHead">
                <span>态势摘要</span>
                <b>{HAZARD_LABELS[fusedHazard]}</b>
              </div>
              <strong>{HAZARD_ACTIONS[fusedHazard]}</strong>
              <p>{agent.rideContext.glanceableFocus}</p>
              <div className="pulseGrid">
                <span>
                  <b>{agent.rideContext.modeLabel}</b>
                  模式
                </span>
                <span>
                  <b>{agent.rideContext.scenarioLabel}</b>
                  场景
                </span>
                <span>
                  <b>{NETWORK_LABELS[agent.rideContext.network]}</b>
                  网络
                </span>
                <span>
                  <b>{agent.rideContext.batteryPct}%</b>
                  电量
                </span>
              </div>
            </div>
            <div className="instrument preflight">
              <div className="instrumentHead">
                <span>{t.onboarding}</span>
                <b>{agent.health?.ok ? t.ready : "check"}</b>
              </div>
              <div className="preflightGrid">
                {preflight.map((item) => (
                  <span key={item.label}>
                    <b>{item.label}</b>
                    {item.value}
                  </span>
                ))}
              </div>
            </div>
            <div className={`instrument rideIntel ${agent.rideContext.hazardLevel}`}>
              <div className="instrumentHead">
                <span>骑行情报</span>
                <b>{agent.rideContext.modeLabel}</b>
              </div>
              <div className="rideIntelGrid">
                <strong>{agent.rideContext.speedKmh}</strong>
                <span>km/h</span>
                <p>{agent.rideContext.routePhase}</p>
              </div>
              <div className="rideChips">
                <span>{agent.rideContext.scenarioLabel}</span>
                <span>{agent.rideContext.network}</span>
                <span>{agent.rideContext.batteryPct}%</span>
              </div>
            </div>
            <WeatherReadout weather={agent.weather} />
            <div className={`instrument diagnostics ${agent.connectionState}`}>
              <div className="instrumentHead">
                <span>系统诊断</span>
                <b>{CONNECTION_LABELS[agent.connectionState]}</b>
              </div>
              <div className="diagnosticGrid">
                <span>凭证</span>
                <strong>{agent.health ? CREDENTIAL_LABELS[agent.health.credentials] : "unknown"}</strong>
                <span>VAD</span>
                <strong>{agent.capabilities.serverVad ? "server" : "off"}</strong>
                <span>音频</span>
                <strong>{agent.capabilities.synthesizedAudio ? "PCM" : "TTS"}</strong>
                <span>记忆</span>
                <strong>{agent.capabilities.sessionMemory ? "on" : "off"}</strong>
                <span>降噪</span>
                <strong>{audioProcessingLabel(agent.audioProcessing.noiseSuppression)}</strong>
                <span>回声</span>
                <strong>{audioProcessingLabel(agent.audioProcessing.echoCancellation)}</strong>
                <span>增益</span>
                <strong>{audioProcessingLabel(agent.audioProcessing.autoGainControl)}</strong>
                <span>采样</span>
                <strong>{agent.audioProcessing.sampleRate ?? SAMPLE_RATE}Hz</strong>
              </div>
              <div className="rideChips">
                <span>{agent.sessionMemory.language === "zh" ? "中文" : "English"}</span>
                <span>{RESPONSE_MODE_LABELS[agent.sessionMemory.responseMode]}</span>
                <span>{agent.sessionMemory.lastIntent ?? "待识别"}</span>
                {agent.sessionMemory.destination ? <span>{agent.sessionMemory.destination}</span> : null}
              </div>
            </div>
            <div className={`instrument latency ${latencyTone}`}>
              <div className="instrumentHead">
                <span>延迟</span>
              </div>
              <div className="latencyValue">
                <strong>{agent.latencyMs}</strong>
                <span>ms</span>
              </div>
              <div className="latencyBar">
                <i style={{ width: `${Math.min(100, agent.latencyMs / 4)}%` }} />
              </div>
              <div className="telemetryGrid">
                <span>ASR {agent.telemetry.asrMs}ms</span>
                <span>思考 {agent.telemetry.thinkMs}ms</span>
                <span>首音 {agent.telemetry.firstAudioMs}ms</span>
                <span>总计 {agent.telemetry.totalMs}ms</span>
                <span>上行 {agent.packetStats.outgoingFps}fps</span>
                <span>丢帧 {agent.packetStats.droppedFrames}</span>
              </div>
            </div>
          </section>

          <section className="hudPanel transcriptPanel">
            <div className="panelHeader">
              <h2>{t.conversation}</h2>
              <div className="panelActions">
                <span>{agent.transcript.length ? `${t.live} · ${agent.transcript.length}` : t.idle}</span>
                <button
                  type="button"
                  onClick={() =>
                    exportTranscriptLog(agent.transcript, agent.health, agent.testerId, agent.testerRegion)
                  }
                  disabled={!agent.transcript.length}
                >
                  {t.exportLog}
                </button>
                <button type="button" onClick={agent.clearTranscript} disabled={!agent.transcript.length}>
                  {t.clearLog}
                </button>
              </div>
            </div>
            <div className="rideHistory">
              <div>
                <span>{t.lastCommand}</span>
                <strong>{lastCommand}</strong>
              </div>
              <div>
                <span>{t.lastReply}</span>
                <strong>{lastReply}</strong>
              </div>
              <div>
                <span>{t.weather}</span>
                <strong>{agent.weather ? `${agent.weather.description} ${agent.weather.temperatureC}°C` : "—"}</strong>
              </div>
              <div>
                <span>{t.connection}</span>
                <strong>{CONNECTION_LABELS[agent.connectionState]}</strong>
              </div>
              <div>
                <span>Tester</span>
                <strong>
                  {currentTester
                    ? `${currentTester.testerId} · ${currentTester.ipAddress} · ${currentTester.region}`
                    : `${agent.testerId} · ${agent.testerRegion}`}
                </strong>
              </div>
            </div>
            <div className="transcriptList">
              {(agent.transcript.length
                ? agent.transcript
                : [
                    {
                      id: 1,
                      at: Date.now(),
                      speaker: "agent" as const,
                      final: true,
                      language: "zh" as const,
                      text: "你好，我是 Max，摩托车头盔 AI 助手。开启免提后直接说话，问我天气、路线或摩托车问题。"
                    }
                  ]
              ).map((item) => (
                <article className={`message ${item.speaker}`} key={item.id}>
                  <span>{item.speaker === "rider" ? "骑手" : "Max"}</span>
                  <div className="messageMeta">
                    <b>{formatClockTime(item.at)}</b>
                    <b>{item.language === "zh" ? "中文" : "EN"}</b>
                    <b>{item.final ? "final" : "live"}</b>
                  </div>
                  <p>{item.text}</p>
                </article>
              ))}
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}
