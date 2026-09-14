import {
  CloudSun,
  DownloadSimple,
  Flask,
  Gauge,
  MapTrifold,
  Pulse,
  SlidersHorizontal,
  Trash,
  Waveform,
  X
} from "@phosphor-icons/react";
import { useEffect, useRef } from "react";
import { combineHazardLevels, scenarioLabel } from "../../shared/ride";
import { LanguageToggle, useLanguage } from "./LanguageToggle";
import { localized } from "../lib/i18n";
import type { AmapConsentControls } from "../hooks/useAmapConsent";
import type { HelmetAgent } from "../hooks/useHelmetAgent";
import {
  CONNECTION_LABELS,
  CONNECTION_LABELS_EN,
  CREDENTIAL_LABELS,
  HAZARD_ACTIONS,
  HAZARD_ACTIONS_EN,
  HAZARD_LABELS,
  HAZARD_LABELS_EN,
  NETWORK_LABELS,
  NETWORK_LABELS_EN,
  PERMISSION_LABELS,
  PERMISSION_LABELS_EN,
  PERSONALITY_LABELS,
  PERSONALITY_LABELS_EN,
  RESPONSE_MODE_LABELS,
  RIDE_MODES,
  RIDE_MODE_LABELS,
  RIDE_MODE_LABELS_EN,
  RESPONSE_MODE_LABELS_EN,
  SAMPLE_RATE,
  SCENARIOS,
  VOICE_PERSONALITIES
} from "../lib/constants";
import { audioProcessingLabel, exportTranscriptLog } from "../lib/utils";

type Props = {
  agent: HelmetAgent;
  amapConsent: AmapConsentControls;
  onOpenAdmin: () => void;
  onClose: () => void;
};

export function WebSettingsSheet({ agent, amapConsent, onOpenAdmin, onClose }: Props) {
  const { language, t } = useLanguage();
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
              <span className="settingsDoneLabel">{t("settings.done")}</span>
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
              <span>{localized(language, "声音", "Voice")}</span>
              <div
                className="settingsSegment"
                role="group"
                aria-label={localized(language, "语音性别", "Voice gender")}
              >
                {(["female", "male"] as const).map((gender) => (
                  <button
                    type="button"
                    key={gender}
                    className={agent.voiceGender === gender ? "active" : ""}
                    aria-pressed={agent.voiceGender === gender}
                    onClick={() => agent.setVoiceGender(gender)}
                  >
                    {gender === "female" ? localized(language, "女声", "Female") : localized(language, "男声", "Male")}
                  </button>
                ))}
              </div>
            </div>
            <div className="settingsGroup">
              <span>{localized(language, "语气", "Tone")}</span>
              <div
                className="settingsSegment wrap"
                role="group"
                aria-label={localized(language, "语气风格", "Voice style")}
              >
                {VOICE_PERSONALITIES.map((personality) => (
                  <button
                    type="button"
                    key={personality}
                    className={agent.voicePersonality === personality ? "active" : ""}
                    aria-pressed={agent.voicePersonality === personality}
                    onClick={() => agent.setVoicePersonality(personality)}
                  >
                    {(language === "en-US" ? PERSONALITY_LABELS_EN : PERSONALITY_LABELS)[personality]}
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
              <span>{localized(language, "模式", "Mode")}</span>
              <div
                className="settingsSegment wrap"
                role="group"
                aria-label={localized(language, "骑行模式", "Ride mode")}
              >
                {RIDE_MODES.map((mode) => (
                  <button
                    type="button"
                    key={mode}
                    className={agent.rideContext.mode === mode ? "active" : ""}
                    aria-pressed={agent.rideContext.mode === mode}
                    onClick={() => agent.setRideMode(mode)}
                  >
                    {(language === "en-US" ? RIDE_MODE_LABELS_EN : RIDE_MODE_LABELS)[mode]}
                  </button>
                ))}
              </div>
            </div>
            <div className="settingsGroup settingsScenarioGroup">
              <span>{localized(language, "演示场景", "Demo scenario")}</span>
              <div
                className="settingsScenarioGrid"
                role="group"
                aria-label={localized(language, "演示场景", "Demo scenario")}
              >
                {SCENARIOS.map((scenario) => (
                  <button
                    type="button"
                    key={scenario}
                    className={agent.rideContext.scenario === scenario ? "active" : ""}
                    aria-pressed={agent.rideContext.scenario === scenario}
                    onClick={() => agent.setScenario(scenario)}
                  >
                    {language === "en-US"
                      ? {
                          commute: "Commute",
                          wind: "Wind",
                          fuel: "Fuel",
                          group: "Group",
                          emergency: "Emergency",
                          adas: "ADAS",
                          crash: "Crash"
                        }[scenario]
                      : scenarioLabel(scenario)}
                  </button>
                ))}
                {agent.provider === "mock" ? (
                  <button
                    type="button"
                    className={agent.guidedDemo ? "active" : ""}
                    aria-pressed={agent.guidedDemo}
                    onClick={() => agent.setGuidedDemo(!agent.guidedDemo)}
                  >
                    {agent.guidedDemo
                      ? localized(language, "停止巡游", "Stop patrol")
                      : localized(language, "自动巡游", "Auto patrol")}
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
                <strong>{(language === "en-US" ? HAZARD_LABELS_EN : HAZARD_LABELS)[fusedHazard]}</strong>
                {(language === "en-US" ? HAZARD_ACTIONS_EN : HAZARD_ACTIONS)[fusedHazard]}
              </p>
              <dl>
                <div>
                  <dt>{localized(language, "网络", "Network")}</dt>
                  <dd>{(language === "en-US" ? NETWORK_LABELS_EN : NETWORK_LABELS)[agent.rideContext.network]}</dd>
                </div>
                <div>
                  <dt>{localized(language, "电量", "Battery")}</dt>
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
                  <span>
                    {localized(language, "风速", "Wind")} {agent.weather.windSpeedKmh} km/h
                  </span>
                </div>
                <p>{agent.weather.riderAdvice}</p>
              </div>
            ) : (
              <p className="settingsEmpty">
                {localized(language, "开启免提后接入定位天气。", "Turn on hands-free to load location weather.")}
              </p>
            )}
          </section>

          <section className="settingsCard">
            <div className="settingsCardTitle">
              <MapTrifold size={22} aria-hidden="true" />
              <div>
                <h2>{localized(language, "高德地图与隐私", "Amap and privacy")}</h2>
                <p>
                  {localized(
                    language,
                    "导航卡片可使用高德地图显示路线底图。",
                    "The navigation card can show an Amap base map."
                  )}
                </p>
              </div>
              <span className={`settingsStatus ${amapConsent.decision === "accepted" ? "online" : ""}`}>
                {amapConsent.decision === "accepted"
                  ? localized(language, "已启用", "On")
                  : localized(language, "未启用", "Off")}
              </span>
            </div>
            <p className="settingsEmpty">
              {localized(
                language,
                "启用后，路线和当前位置会提供给高德地图用于地图显示，高德还会接收加载地图所需的网络请求。未启用时只显示本地路线示意图，不会向高德发出任何请求。",
                "Once enabled, your route and current position are shared with Amap to draw the map, and Amap receives the network requests needed to load it. While it is off, only the local route schematic is drawn and no request reaches Amap."
              )}
            </p>
            <a href="https://lbs.amap.com/pages/privacy/" target="_blank" rel="noreferrer noopener">
              {localized(language, "查看高德地图隐私政策", "Read the Amap privacy policy")}
            </a>
            <div className="settingsActions">
              {amapConsent.decision === "accepted" ? (
                <button type="button" onClick={amapConsent.decline}>
                  {localized(language, "停用地图", "Turn the map off")}
                </button>
              ) : (
                <button type="button" onClick={amapConsent.accept}>
                  {localized(language, "同意并启用", "Agree and enable")}
                </button>
              )}
            </div>
          </section>

          <section className="settingsCard">
            <div className="settingsCardTitle">
              <SlidersHorizontal size={22} aria-hidden="true" />
              <div>
                <h2>{t("settings.connection")}</h2>
                <p>{(language === "en-US" ? CONNECTION_LABELS_EN : CONNECTION_LABELS)[agent.connectionState]}</p>
              </div>
              <span className={`settingsStatus ${agent.connected ? "online" : ""}`}>
                {(language === "en-US" ? CONNECTION_LABELS_EN : CONNECTION_LABELS)[agent.connectionState]}
              </span>
            </div>
            <dl className="settingsMetrics">
              <div>
                <dt>{localized(language, "服务", "Service")}</dt>
                <dd>{agent.provider.toUpperCase()}</dd>
              </div>
              <div>
                <dt>{localized(language, "凭证", "Credentials")}</dt>
                <dd>{agent.health ? CREDENTIAL_LABELS[agent.health.credentials] : "unknown"}</dd>
              </div>
              <div>
                <dt>{localized(language, "麦克风", "Microphone")}</dt>
                <dd>{(language === "en-US" ? PERMISSION_LABELS_EN : PERMISSION_LABELS)[agent.micPermission]}</dd>
              </div>
              <div>
                <dt>{localized(language, "定位", "Location")}</dt>
                <dd>{(language === "en-US" ? PERMISSION_LABELS_EN : PERMISSION_LABELS)[agent.locationPermission]}</dd>
              </div>
            </dl>
          </section>

          <section className="settingsCard">
            <div className="settingsCardTitle">
              <Pulse size={22} aria-hidden="true" />
              <div>
                <h2>{localized(language, "诊断", "Diagnostics")}</h2>
                <p>{localized(language, "语音链路和实时性能", "Voice path and real-time performance")}</p>
              </div>
              <strong className={`settingsLatency ${latencyTone}`}>{agent.latencyMs} ms</strong>
            </div>
            <dl className="settingsMetrics compact">
              <div>
                <dt>ASR</dt>
                <dd>{agent.telemetry.asrMs} ms</dd>
              </div>
              <div>
                <dt>{localized(language, "思考", "Thinking")}</dt>
                <dd>{agent.telemetry.thinkMs} ms</dd>
              </div>
              <div>
                <dt>{localized(language, "首音", "First audio")}</dt>
                <dd>{agent.telemetry.firstAudioMs} ms</dd>
              </div>
              <div>
                <dt>{localized(language, "总计", "Total")}</dt>
                <dd>{agent.telemetry.totalMs} ms</dd>
              </div>
              <div>
                <dt>{localized(language, "降噪", "Noise reduction")}</dt>
                <dd>{audioProcessingLabel(agent.audioProcessing.noiseSuppression, language)}</dd>
              </div>
              <div>
                <dt>{localized(language, "回声消除", "Echo cancellation")}</dt>
                <dd>{audioProcessingLabel(agent.audioProcessing.echoCancellation, language)}</dd>
              </div>
              <div>
                <dt>{localized(language, "采样", "Sample rate")}</dt>
                <dd>{agent.audioProcessing.sampleRate ?? SAMPLE_RATE} Hz</dd>
              </div>
              <div>
                <dt>{localized(language, "响应", "Response")}</dt>
                <dd>
                  {
                    (language === "en-US" ? RESPONSE_MODE_LABELS_EN : RESPONSE_MODE_LABELS)[
                      agent.sessionMemory.responseMode
                    ]
                  }
                </dd>
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
