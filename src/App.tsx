import { useEffect, useMemo } from "react";
import { HelmetVisual } from "./components/HelmetVisual";
import { SignalBars, WeatherReadout } from "./components/Instruments";
import { adasDirectionLabel } from "../shared/adas";
import { combineHazardLevels, scenarioLabel } from "../shared/ride";
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
import { audioProcessingLabel, exportTranscriptLog, formatClockTime } from "./lib/utils";
import { useHelmetAgent } from "./hooks/useHelmetAgent";

export function App() {
  const agent = useHelmetAgent();
  const t = UI_TEXT[agent.sessionMemory.language];
  const { listening, startMic, stopMic } = agent;

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
      if (listening) {
        stopMic();
      } else {
        void startMic();
      }
    };

    window.addEventListener("keydown", toggleHandsFree);
    return () => window.removeEventListener("keydown", toggleHandsFree);
  }, [listening, startMic, stopMic]);

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
                onClick={agent.listening ? agent.stopMic : agent.startMic}
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
                  onClick={() => exportTranscriptLog(agent.transcript)}
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
