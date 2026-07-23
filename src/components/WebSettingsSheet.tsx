import {
  CloudSun,
  DownloadSimple,
  Flask,
  Gauge,
  Pulse,
  SlidersHorizontal,
  Trash,
  Waveform,
  X
} from "@phosphor-icons/react";
import { useEffect, useRef } from "react";
import { combineHazardLevels, scenarioLabel } from "../../shared/ride";
import { LanguageToggle, useLanguage } from "./LanguageToggle";
import type { HelmetAgent } from "../hooks/useHelmetAgent";
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
  VOICE_PERSONALITIES
} from "../lib/constants";
import { audioProcessingLabel, exportTranscriptLog } from "../lib/utils";

type Props = {
  agent: HelmetAgent;
  onOpenAdmin: () => void;
  onClose: () => void;
};

export function WebSettingsSheet({ agent, onOpenAdmin, onClose }: Props) {
  const { t } = useLanguage();
  const fusedHazard = combineHazardLevels(agent.rideContext.hazardLevel, agent.weather?.riskLevel ?? "normal");
  const latencyTone = agent.latencyMs < 140 ? "good" : agent.latencyMs < 280 ? "warn" : "alert";
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    const handleDialogKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, a[href], [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable?.length) return;
      const first = focusable.item(0);
      const last = focusable.item(focusable.length - 1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleDialogKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleDialogKey);
      previousFocus?.focus();
    };
  }, [onClose]);

  return (
    <div
      className="settingsBackdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="settingsSheet"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <header className="settingsHeader">
          <div>
            <span>Max</span>
            <h1 id="settings-title">{t("settings.title")}</h1>
          </div>
          <div className="settingsHeaderActions">
            <LanguageToggle />
            <button ref={closeButtonRef} type="button" onClick={onClose} aria-label={t("settings.doneAria")}>
            <X size={24} weight="bold" aria-hidden="true" />
            {t("settings.done")}
            </button>
          </div>
        </header>

        <div className="settingsContent">
          <section className="settingsCard">
            <div className="settingsCardTitle">
              <Waveform size={22} aria-hidden="true" />
              <div>
                <h2>{t("settings.voice")}</h2>
                <p>{t("settings.voiceHelp")}</p>
              </div>
            </div>
            <div className="settingsGroup">
              <span>声音</span>
              <div className="settingsSegment" role="group" aria-label="语音性别">
                {(["female", "male"] as const).map((gender) => (
                  <button
                    type="button"
                    key={gender}
                    className={agent.voiceGender === gender ? "active" : ""}
                    aria-pressed={agent.voiceGender === gender}
                    onClick={() => agent.setVoiceGender(gender)}
                  >
                    {gender === "female" ? "女声" : "男声"}
                  </button>
                ))}
              </div>
            </div>
            <div className="settingsGroup">
              <span>语气</span>
              <div className="settingsSegment wrap" role="group" aria-label="语气风格">
                {VOICE_PERSONALITIES.map((personality) => (
                  <button
                    type="button"
                    key={personality}
                    className={agent.voicePersonality === personality ? "active" : ""}
                    aria-pressed={agent.voicePersonality === personality}
                    onClick={() => agent.setVoicePersonality(personality)}
                  >
                    {PERSONALITY_LABELS[personality]}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="settingsCard">
            <div className="settingsCardTitle">
              <Gauge size={22} aria-hidden="true" />
              <div>
                <h2>{t("settings.ride")}</h2>
                <p>{t("settings.rideHelp")}</p>
              </div>
            </div>
            <div className="settingsGroup">
              <span>模式</span>
              <div className="settingsSegment wrap" role="group" aria-label="骑行模式">
                {RIDE_MODES.map((mode) => (
                  <button
                    type="button"
                    key={mode}
                    className={agent.rideContext.mode === mode ? "active" : ""}
                    aria-pressed={agent.rideContext.mode === mode}
                    onClick={() => agent.setRideMode(mode)}
                  >
                    {RIDE_MODE_LABELS[mode]}
                  </button>
                ))}
              </div>
            </div>
            <div className="settingsGroup settingsScenarioGroup">
              <span>演示场景</span>
              <div className="settingsScenarioGrid" role="group" aria-label="演示场景">
                {SCENARIOS.map((scenario) => (
                  <button
                    type="button"
                    key={scenario}
                    className={agent.rideContext.scenario === scenario ? "active" : ""}
                    aria-pressed={agent.rideContext.scenario === scenario}
                    onClick={() => agent.setScenario(scenario)}
                  >
                    {scenarioLabel(scenario)}
                  </button>
                ))}
                {agent.provider === "mock" ? (
                  <button
                    type="button"
                    className={agent.guidedDemo ? "active" : ""}
                    aria-pressed={agent.guidedDemo}
                    onClick={() => agent.setGuidedDemo(!agent.guidedDemo)}
                  >
                    {agent.guidedDemo ? "停止巡游" : "自动巡游"}
                  </button>
                ) : null}
              </div>
            </div>
            <div className={`settingsRideSummary ${fusedHazard}`}>
              <div>
                <strong>{agent.rideContext.speedKmh}</strong>
                <span>km/h</span>
              </div>
              <p>
                <strong>{HAZARD_LABELS[fusedHazard]}</strong>
                {HAZARD_ACTIONS[fusedHazard]}
              </p>
              <dl>
                <div>
                  <dt>网络</dt>
                  <dd>{NETWORK_LABELS[agent.rideContext.network]}</dd>
                </div>
                <div>
                  <dt>电量</dt>
                  <dd>{agent.rideContext.batteryPct}%</dd>
                </div>
              </dl>
            </div>
          </section>

          <section className="settingsCard">
            <div className="settingsCardTitle">
              <CloudSun size={22} aria-hidden="true" />
              <div>
                <h2>{t("settings.weather")}</h2>
                <p>{t("settings.weatherHelp")}</p>
              </div>
            </div>
            {agent.weather ? (
              <div className={`settingsWeather ${agent.weather.riskLevel}`}>
                <strong>{agent.weather.temperatureC}°</strong>
                <div>
                  <b>{agent.weather.description}</b>
                  <span>风速 {agent.weather.windSpeedKmh} km/h</span>
                </div>
                <p>{agent.weather.riderAdvice}</p>
              </div>
            ) : (
              <p className="settingsEmpty">开启免提后接入定位天气。</p>
            )}
          </section>

          <section className="settingsCard">
            <div className="settingsCardTitle">
              <SlidersHorizontal size={22} aria-hidden="true" />
              <div>
                <h2>{t("settings.connection")}</h2>
                <p>{agent.status}</p>
              </div>
              <span className={`settingsStatus ${agent.connected ? "online" : ""}`}>
                {CONNECTION_LABELS[agent.connectionState]}
              </span>
            </div>
            <dl className="settingsMetrics">
              <div>
                <dt>服务</dt>
                <dd>{agent.provider.toUpperCase()}</dd>
              </div>
              <div>
                <dt>凭证</dt>
                <dd>{agent.health ? CREDENTIAL_LABELS[agent.health.credentials] : "unknown"}</dd>
              </div>
              <div>
                <dt>麦克风</dt>
                <dd>{PERMISSION_LABELS[agent.micPermission]}</dd>
              </div>
              <div>
                <dt>定位</dt>
                <dd>{PERMISSION_LABELS[agent.locationPermission]}</dd>
              </div>
            </dl>
          </section>

          <section className="settingsCard">
            <div className="settingsCardTitle">
              <Pulse size={22} aria-hidden="true" />
              <div>
                <h2>诊断</h2>
                <p>语音链路和实时性能</p>
              </div>
              <strong className={`settingsLatency ${latencyTone}`}>{agent.latencyMs} ms</strong>
            </div>
            <dl className="settingsMetrics compact">
              <div>
                <dt>ASR</dt>
                <dd>{agent.telemetry.asrMs} ms</dd>
              </div>
              <div>
                <dt>思考</dt>
                <dd>{agent.telemetry.thinkMs} ms</dd>
              </div>
              <div>
                <dt>首音</dt>
                <dd>{agent.telemetry.firstAudioMs} ms</dd>
              </div>
              <div>
                <dt>总计</dt>
                <dd>{agent.telemetry.totalMs} ms</dd>
              </div>
              <div>
                <dt>降噪</dt>
                <dd>{audioProcessingLabel(agent.audioProcessing.noiseSuppression)}</dd>
              </div>
              <div>
                <dt>回声消除</dt>
                <dd>{audioProcessingLabel(agent.audioProcessing.echoCancellation)}</dd>
              </div>
              <div>
                <dt>采样</dt>
                <dd>{agent.audioProcessing.sampleRate ?? SAMPLE_RATE} Hz</dd>
              </div>
              <div>
                <dt>响应</dt>
                <dd>{RESPONSE_MODE_LABELS[agent.sessionMemory.responseMode]}</dd>
              </div>
            </dl>
            <div className="settingsActions">
              <button
                type="button"
                disabled={!agent.transcript.length}
                onClick={() => exportTranscriptLog(agent.transcript, agent.health, agent.testerId, agent.testerRegion)}
              >
                <DownloadSimple size={18} aria-hidden="true" />
                {t("settings.export")}
              </button>
              <button type="button" disabled={!agent.transcript.length} onClick={agent.clearTranscript}>
                <Trash size={18} aria-hidden="true" />
                {t("settings.clear")}
              </button>
            </div>
          </section>
        </div>
        <footer className="settingsAdminFooter">
          <button type="button" className="settingsAdminAction" onClick={onOpenAdmin}>
            <Flask size={22} aria-hidden="true" />
            <span>
              <strong>{t("settings.admin")}</strong>
              <small>{t("settings.adminHelp")}</small>
            </span>
            <span className="settingsAdminActionLabel">{t("settings.openWorkspace")}</span>
          </button>
        </footer>
      </section>
    </div>
  );
}
