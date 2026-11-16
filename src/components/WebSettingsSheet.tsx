import { CaretDown, CaretRight, DownloadSimple, Flask, ShieldCheck, Trash, X } from "@phosphor-icons/react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import type { VoiceProviderSummary } from "../../shared/agent";
import { combineHazardLevels, scenarioLabel } from "../../shared/ride";
import { useAssistant } from "./AssistantContext";
import { LanguageToggle, useLanguage } from "./LanguageToggle";
import { VisorMark } from "./VisorVisual";
import { deviceCopyKey, localized } from "../lib/i18n";
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
  onOpenTesting: () => void;
  onOpenAdmin?: () => void;
  onClose: () => void;
};

/** A labelled group of rows. The label sits outside the group so hierarchy
 *  comes from spacing and one surface step, not nested boxes. */
function Section({ title, help, children }: { title: string; help?: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="settingsSection" aria-labelledby={id}>
      <h2 className="settingsSectionLabel" id={id}>
        {title}
      </h2>
      <div className="settingsList">{children}</div>
      {help ? <p className="settingsSectionHelp">{help}</p> : null}
    </section>
  );
}

/** One row: label (and optional detail) on the left, control or value right.
 *  `stack` puts a wide control under the label instead. */
function Row({
  label,
  detail,
  stack = false,
  className = "",
  children
}: {
  label: ReactNode;
  detail?: ReactNode;
  stack?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={`settingsRow${stack ? " stack" : ""}${className ? ` ${className}` : ""}`}>
      <div className="settingsRowText">
        <span className="settingsRowLabel">{label}</span>
        {detail ? <span className="settingsRowDetail">{detail}</span> : null}
      </div>
      {children !== undefined ? <div className="settingsRowControl">{children}</div> : null}
    </div>
  );
}

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  wrap = false
}: {
  label: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  wrap?: boolean;
}) {
  return (
    <div className={`settingsSegment${wrap ? " wrap" : ""}`} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          className={value === option.value ? "active" : ""}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function WebSettingsSheet({ agent, amapConsent, onOpenTesting, onOpenAdmin, onClose }: Props) {
  const { language, t } = useLanguage();
  const assistant = useAssistant();
  const en = language === "en-US";
  const fusedHazard = combineHazardLevels(agent.rideContext.hazardLevel, agent.weather?.riskLevel ?? "normal");
  const latencyTone = agent.latencyMs < 140 ? "good" : agent.latencyMs < 280 ? "warn" : "alert";
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const voice = agent.health?.voice;
  const providers = voice?.providers ?? [];
  const providerLabel = (id: string) => providers.find((provider) => provider.id === id)?.label ?? id;
  const canPickBackend = Boolean(voice?.switching && providers.length);
  const selectedBackend =
    agent.voiceProvider && providers.some((provider) => provider.id === agent.voiceProvider)
      ? agent.voiceProvider
      : (voice?.active ?? "");
  const connectionLabels = en ? CONNECTION_LABELS_EN : CONNECTION_LABELS;
  const permissionLabels = en ? PERMISSION_LABELS_EN : PERMISSION_LABELS;

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

  const backendOption = (provider: VoiceProviderSummary) => {
    const selected = provider.id === selectedBackend;
    return (
      <button
        type="button"
        key={provider.id}
        className={`backendOption${selected ? " active" : ""}`}
        aria-pressed={selected}
        disabled={!provider.configured}
        onClick={() => agent.setVoiceProvider(provider.id)}
      >
        <span className="backendRadio" aria-hidden="true" />
        <span className="backendText">
          <span className="backendTitle">
            <strong>{provider.label}</strong>
            <span className={`backendKind ${provider.kind}`}>{t(`settings.backendKind.${provider.kind}`)}</span>
          </span>
          {provider.description ? <span className="backendDescription">{provider.description}</span> : null}
          {!provider.configured ? <span className="backendMissing">{t("settings.needsKey")}</span> : null}
        </span>
      </button>
    );
  };

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
          <h1 id="settings-title">{t("settings.title")}</h1>
          <div className="settingsHeaderActions">
            <LanguageToggle />
            <button
              ref={closeButtonRef}
              type="button"
              className="settingsDone"
              onClick={onClose}
              aria-label={t("settings.doneAria")}
            >
              <X className="settingsDoneIcon" size={20} weight="bold" aria-hidden="true" />
              <span className="settingsDoneLabel">{t("settings.done")}</span>
            </button>
          </div>
        </header>

        <div className="settingsContent">
          <Section title={t("settings.assistant")} help={canPickBackend ? t("settings.voiceBackendHelp") : undefined}>
            <div className="settingsIdentity">
              <VisorMark />
              <div>
                <strong>{assistant.name}</strong>
                <span>{assistant.tagline || t(deviceCopyKey("voice.assistantKind", assistant.device))}</span>
              </div>
            </div>
            <Row label={t("settings.wakePhrase")}>
              <span className="settingsValue">
                {assistant.wakeWordEnabled ? `“${assistant.wakePhrase}”` : t("settings.wakeOff")}
              </span>
            </Row>
            {canPickBackend ? (
              <Row label={t("settings.voiceBackend")} stack>
                <div className="backendList" role="group" aria-label={t("settings.voiceBackend")}>
                  {providers.map(backendOption)}
                </div>
              </Row>
            ) : (
              <Row label={t("settings.voiceBackend")} detail={voice ? t("settings.voiceBackendFixed") : undefined}>
                <span className="settingsValue">{voice ? providerLabel(voice.active) : agent.provider}</span>
              </Row>
            )}
            <Row label={t("settings.liveBackend")}>
              <span className={`settingsValue${agent.sessionProvider ? " live" : " muted"}`}>
                {agent.sessionProvider ? providerLabel(agent.sessionProvider) : t("settings.liveBackendNone")}
              </span>
            </Row>
          </Section>

          <Section title={t("settings.voice")}>
            <Row label={localized(language, "声音", "Voice")}>
              <Segmented
                label={localized(language, "语音性别", "Voice gender")}
                value={agent.voiceGender}
                onChange={agent.setVoiceGender}
                options={[
                  { value: "female", label: localized(language, "女声", "Female") },
                  { value: "male", label: localized(language, "男声", "Male") }
                ]}
              />
            </Row>
            <Row
              label={localized(language, "语气", "Tone")}
              detail={t("settings.voiceHelp", { name: assistant.name })}
              stack
            >
              <Segmented
                label={localized(language, "语气风格", "Voice style")}
                value={agent.voicePersonality}
                onChange={agent.setVoicePersonality}
                wrap
                options={VOICE_PERSONALITIES.map((personality) => ({
                  value: personality,
                  label: (en ? PERSONALITY_LABELS_EN : PERSONALITY_LABELS)[personality]
                }))}
              />
            </Row>
          </Section>

          <Section title={t(deviceCopyKey("settings.ride", assistant.device))}>
            <Row label={localized(language, "模式", "Mode")} stack>
              <Segmented
                label={localized(language, "骑行模式", "Ride mode")}
                value={agent.rideContext.mode}
                onChange={agent.setRideMode}
                wrap
                options={RIDE_MODES.map((mode) => ({
                  value: mode,
                  label: (en ? RIDE_MODE_LABELS_EN : RIDE_MODE_LABELS)[mode]
                }))}
              />
            </Row>
            <Row
              className={`settingsCondition ${fusedHazard}`}
              label={(en ? HAZARD_LABELS_EN : HAZARD_LABELS)[fusedHazard]}
              detail={(en ? HAZARD_ACTIONS_EN : HAZARD_ACTIONS)[fusedHazard]}
            >
              <span className="settingsValue mono">
                {agent.rideContext.speedKmh}
                <small> km/h</small>
              </span>
            </Row>
            <Row label={localized(language, "网络", "Network")}>
              <span className="settingsValue">
                {(en ? NETWORK_LABELS_EN : NETWORK_LABELS)[agent.rideContext.network]}
              </span>
            </Row>
            <Row label={localized(language, "电量", "Battery")}>
              <span className="settingsValue mono">{agent.rideContext.batteryPct}%</span>
            </Row>
            {agent.weather ? (
              <Row
                className={`settingsWeather ${agent.weather.riskLevel}`}
                label={`${t("settings.weather")} · ${agent.weather.description}`}
                detail={agent.weather.riderAdvice}
              >
                <span className="settingsValue mono">
                  {agent.weather.temperatureC}°
                  <small>
                    {" "}
                    {localized(language, "风", "wind")} {agent.weather.windSpeedKmh} km/h
                  </small>
                </span>
              </Row>
            ) : (
              <Row
                label={t("settings.weather")}
                detail={localized(language, "开启免提后接入定位天气。", "Turn on hands-free to load location weather.")}
              />
            )}
          </Section>

          <Section title={t("settings.workspaces")}>
            <button type="button" className="settingsRow settingsLink" onClick={onOpenTesting}>
              <Flask size={20} aria-hidden="true" />
              <span className="settingsRowText">
                <span className="settingsRowLabel">{t("settings.testing")}</span>
                <span className="settingsRowDetail">{t("settings.testingHelp")}</span>
              </span>
              <CaretRight className="settingsChevron" size={16} aria-hidden="true" />
            </button>
            {onOpenAdmin ? (
              <button type="button" className="settingsRow settingsLink" onClick={onOpenAdmin}>
                <ShieldCheck size={20} aria-hidden="true" />
                <span className="settingsRowText">
                  <span className="settingsRowLabel">{t("settings.admin")}</span>
                  <span className="settingsRowDetail">{t("settings.adminHelp")}</span>
                </span>
                <CaretRight className="settingsChevron" size={16} aria-hidden="true" />
              </button>
            ) : null}
          </Section>

          <Section title={localized(language, "地图与隐私", "Map and privacy")}>
            <Row
              label={localized(language, "高德地图底图", "Amap base map")}
              detail={localized(
                language,
                "启用后，路线和当前位置会提供给高德地图用于地图显示，高德还会接收加载地图所需的网络请求。未启用时只显示本地路线示意图，不会向高德发出任何请求。",
                "Once enabled, your route and current position are shared with Amap to draw the map, and Amap receives the network requests needed to load it. While it is off, only the local route schematic is drawn and no request reaches Amap."
              )}
              stack
            >
              <div className="settingsInlineActions">
                {amapConsent.decision === "accepted" ? (
                  <button type="button" className="settingsButton" onClick={amapConsent.decline}>
                    {localized(language, "停用地图", "Turn the map off")}
                  </button>
                ) : (
                  <button type="button" className="settingsButton primary" onClick={amapConsent.accept}>
                    {localized(language, "同意并启用", "Agree and enable")}
                  </button>
                )}
                <span className={`settingsPill${amapConsent.decision === "accepted" ? " on" : ""}`}>
                  {amapConsent.decision === "accepted"
                    ? localized(language, "已启用", "On")
                    : localized(language, "未启用", "Off")}
                </span>
                <a href="https://lbs.amap.com/pages/privacy/" target="_blank" rel="noreferrer noopener">
                  {localized(language, "高德地图隐私政策", "Amap privacy policy")}
                </a>
              </div>
            </Row>
          </Section>

          <Section title={t("settings.connection")}>
            <Row label={localized(language, "状态", "Status")}>
              <span className={`settingsPill${agent.connected ? " on" : ""}`}>
                {connectionLabels[agent.connectionState]}
              </span>
            </Row>
            <Row label={localized(language, "服务", "Service")}>
              <span className="settingsValue mono">{agent.provider}</span>
            </Row>
            <Row label={localized(language, "凭证", "Credentials")}>
              <span className="settingsValue mono">
                {agent.health ? CREDENTIAL_LABELS[agent.health.credentials] : "unknown"}
              </span>
            </Row>
            <Row label={localized(language, "麦克风", "Microphone")}>
              <span className="settingsValue">{permissionLabels[agent.micPermission]}</span>
            </Row>
            <Row label={localized(language, "定位", "Location")}>
              <span className="settingsValue">{permissionLabels[agent.locationPermission]}</span>
            </Row>
          </Section>

          <details className="settingsDisclosure">
            <summary>
              <span className="settingsRowText">
                <span className="settingsRowLabel">{localized(language, "测试与诊断", "Testing & diagnostics")}</span>
                <span className="settingsRowDetail">
                  {agent.provider === "mock" && agent.guidedDemo
                    ? localized(language, "自动巡游运行中", "Auto patrol is running")
                    : localized(
                        language,
                        "演示场景、语音性能和对话记录",
                        "Demo scenarios, voice performance, and conversation logs"
                      )}
                </span>
              </span>
              <CaretDown className="settingsDisclosureCaret" size={16} aria-hidden="true" />
            </summary>
            <div className="settingsDisclosureContent">
              <Section
                title={localized(language, "演示场景", "Demo scenarios")}
                help={localized(
                  language,
                  "用于测试模拟骑行状态。选择场景会改变当前骑行情境。",
                  "Simulate ride conditions for testing. Selecting a scenario changes the current ride context."
                )}
              >
                <div className="settingsRow stack">
                  <div
                    className="settingsSegment wrap settingsScenarioGrid"
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
                        {en
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
              </Section>
              <Section title={localized(language, "诊断", "Diagnostics")}>
                <Row label={localized(language, "端到端延迟", "Round-trip latency")}>
                  <span className={`settingsValue mono settingsLatency ${latencyTone}`}>{agent.latencyMs} ms</span>
                </Row>
                <dl className="settingsMetrics">
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
                    <dd>{(en ? RESPONSE_MODE_LABELS_EN : RESPONSE_MODE_LABELS)[agent.sessionMemory.responseMode]}</dd>
                  </div>
                </dl>
                <div className="settingsRow settingsInlineActions">
                  <button
                    type="button"
                    className="settingsButton"
                    disabled={!agent.transcript.length}
                    onClick={() =>
                      exportTranscriptLog(agent.transcript, agent.health, agent.testerId, agent.testerRegion)
                    }
                  >
                    <DownloadSimple size={16} aria-hidden="true" />
                    {t("settings.export")}
                  </button>
                  <button
                    type="button"
                    className="settingsButton danger"
                    disabled={!agent.transcript.length}
                    onClick={agent.clearTranscript}
                  >
                    <Trash size={16} aria-hidden="true" />
                    {t("settings.clear")}
                  </button>
                </div>
              </Section>
            </div>
          </details>
        </div>
      </section>
    </div>
  );
}
