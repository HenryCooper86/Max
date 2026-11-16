import { UploadSimple, WarningCircle, X } from "@phosphor-icons/react";
import { useId, useRef, type ReactNode } from "react";
import type { VoiceEqualizerOptions } from "../../../shared/agent";
import type { AssistantDraft, DraftErrors } from "../../lib/assistant-config";
import { BACKENDS, DEVICES, deviceLogoUrl, findDevice, LANGUAGES, type BackendInfo } from "../../lib/device-catalog";
import { localized } from "../../lib/i18n";
import { findTemplate } from "../../lib/templates";
import { VISUALIZERS } from "../../lib/visualizer";
import { useLanguage } from "../LanguageToggle";
import { TemplatePicker } from "../TemplatePicker";
import { VisualizerPicker } from "../VisualizerPicker";
import { VoiceEqualizerPanel } from "../VoiceEqualizerPanel";

// The one set of controls for an assistant's configuration. The public
// configurator shows them as steps; the admin Studio shows them all at once.

type FieldProps = {
  draft: AssistantDraft;
  onChange: (patch: Partial<AssistantDraft>) => void;
  errors: DraftErrors;
};

/** A labelled control with optional help and an error underneath. */
function Field({
  label,
  hint,
  error,
  children,
  htmlFor
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className={`studioField${error ? " invalid" : ""}`}>
      {htmlFor ? (
        <label className="studioLabel" htmlFor={htmlFor}>
          {label}
        </label>
      ) : (
        <span className="studioLabel">{label}</span>
      )}
      {children}
      {hint ? <p className="studioHint">{hint}</p> : null}
      {error ? (
        <p className="studioError" role="alert">
          <WarningCircle size={16} aria-hidden="true" /> {error}
        </p>
      ) : null}
    </div>
  );
}

export function DeviceFields({ draft, onChange, errors }: FieldProps) {
  const { language } = useLanguage();
  const en = language === "en-US";
  const name = useId();
  return (
    <Field label={localized(language, "戴在哪里", "Where it's worn")} error={errors.device}>
      <fieldset className="deviceChoices">
        <legend className="visuallyHidden">{localized(language, "设备", "Device")}</legend>
        {DEVICES.map((device) => {
          const selected = device.id === draft.device;
          const logo = deviceLogoUrl(device.id);
          return (
            <label key={device.id} className={`deviceChoice${selected ? " active" : ""}`}>
              <input
                className="visuallyHidden"
                type="radio"
                name={name}
                value={device.id}
                checked={selected}
                onChange={() => onChange({ device: device.id })}
              />
              {logo ? <img src={logo} alt="" width={40} height={40} /> : null}
              <span>
                <strong>{en ? device.label.en : device.label.zh}</strong>
                <small>{en ? device.note.en : device.note.zh}</small>
              </span>
            </label>
          );
        })}
      </fieldset>
    </Field>
  );
}

/** Wake names typed as a comma-separated list; spaces inside a name stay. */
function splitNames(value: string): string[] {
  return value.split(/[,，]\s*/);
}

export function IdentityFields({ draft, onChange, errors }: FieldProps) {
  const { language } = useLanguage();
  const id = useId();
  const say = (zh: string, en: string) => localized(language, zh, en);
  const toggleLanguage = (code: string) =>
    onChange({
      languages: draft.languages.includes(code)
        ? draft.languages.filter((item) => item !== code)
        : [...draft.languages, code]
    });
  return (
    <>
      <Field
        label={say("名字", "Name")}
        htmlFor={`${id}-name`}
        hint={say(
          "说出名字即可唤醒，界面上也显示这个名字。",
          "People say it to wake the assistant, and the apps show it."
        )}
        error={errors.name}
      >
        <input
          id={`${id}-name`}
          className="studioInput"
          value={draft.name}
          maxLength={40}
          autoComplete="off"
          placeholder="Max"
          aria-invalid={errors.name ? true : undefined}
          onChange={(event) => onChange({ name: event.currentTarget.value })}
        />
      </Field>
      <Field
        label={say("其他唤醒名", "Other wake names")}
        htmlFor={`${id}-wake`}
        hint={say(
          "可选，用逗号分隔，例如别名或另一种语言的叫法。",
          "Optional, separated by commas: a nickname, or the name in another language."
        )}
        error={errors.wakeNames}
      >
        <input
          id={`${id}-wake`}
          className="studioInput"
          value={draft.wakeNames.join(", ")}
          autoComplete="off"
          onChange={(event) => onChange({ wakeNames: splitNames(event.currentTarget.value) })}
        />
      </Field>
      <Field
        label={say("语言", "Languages")}
        hint={say("第一个是默认回答语言。", "The first one is the language it answers in by default.")}
        error={errors.languages}
      >
        <div className="languageChips" role="group" aria-label={say("语言", "Languages")}>
          {LANGUAGES.map((entry) => {
            const position = draft.languages.indexOf(entry.code);
            return (
              <button
                type="button"
                key={entry.code}
                className={`languageChip${position >= 0 ? " active" : ""}`}
                aria-pressed={position >= 0}
                onClick={() => toggleLanguage(entry.code)}
              >
                {position >= 0 ? <span className="languageOrder">{position + 1}</span> : null}
                {language === "en-US" ? entry.label.en : entry.label.zh}
              </button>
            );
          })}
        </div>
        <label className="studioCheck">
          <input
            type="checkbox"
            checked={draft.strictLanguages === true}
            onChange={(event) => onChange({ strictLanguages: event.currentTarget.checked ? true : null })}
          />
          {say("只用这些语言回答", "Only answer in these languages")}
        </label>
      </Field>
      <div className="studioPair">
        <Field
          label={say("开发者", "Made by")}
          htmlFor={`${id}-developer`}
          hint={say("可选，显示在登录页底部。", "Optional. Shown at the foot of the sign-in page.")}
          error={errors.developer}
        >
          <input
            id={`${id}-developer`}
            className="studioInput"
            value={draft.developer}
            maxLength={100}
            autoComplete="organization"
            onChange={(event) => onChange({ developer: event.currentTarget.value })}
          />
        </Field>
        <Field
          label={say("一句话介绍", "Tagline")}
          htmlFor={`${id}-tagline`}
          hint={say("可选，显示在名字下面。", "Optional. Shown under the name.")}
          error={errors.tagline}
        >
          <input
            id={`${id}-tagline`}
            className="studioInput"
            value={draft.tagline}
            maxLength={100}
            onChange={(event) => onChange({ tagline: event.currentTarget.value })}
          />
        </Field>
      </div>
    </>
  );
}

/** Logo controls differ: the configurator previews a local file, the Studio
 *  uploads to the relay. */
export type LogoControls = {
  /** URL of the logo in use, if the owner has their own. */
  customUrl?: string;
  busy?: boolean;
  error?: string;
  note?: string;
  onPick: (file: File) => void;
  onRemove: () => void;
};

function LogoField({ deviceId, logo }: { deviceId: string; logo: LogoControls }) {
  const { language } = useLanguage();
  const input = useRef<HTMLInputElement>(null);
  const say = (zh: string, en: string) => localized(language, zh, en);
  const shown = logo.customUrl ?? deviceLogoUrl(deviceId);
  return (
    <Field
      label={say("标志", "Logo")}
      hint={logo.note ?? say("正方形的 SVG 或 PNG，最大 512 KB。", "A square SVG or PNG, up to 512 KB.")}
      error={logo.error}
    >
      <div className="logoRow">
        {shown ? <img className="logoPreview" src={shown} alt="" width={56} height={56} /> : null}
        <span className="logoSource">
          {logo.customUrl ? say("你的标志", "Your logo") : say("设备标志", "The device's mark")}
        </span>
        <input
          ref={input}
          className="visuallyHidden"
          type="file"
          accept="image/svg+xml,image/png"
          tabIndex={-1}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) logo.onPick(file);
          }}
        />
        <button type="button" className="studioButton" disabled={logo.busy} onClick={() => input.current?.click()}>
          <UploadSimple size={16} aria-hidden="true" />
          {logo.customUrl ? say("换一个", "Replace") : say("用自己的标志", "Use your own")}
        </button>
        {logo.customUrl ? (
          <button type="button" className="studioButton quiet" disabled={logo.busy} onClick={logo.onRemove}>
            <X size={16} aria-hidden="true" />
            {say("改回设备标志", "Use the device mark")}
          </button>
        ) : null}
      </div>
    </Field>
  );
}

export function LookFields({ draft, onChange, errors, logo }: FieldProps & { logo: LogoControls }) {
  const { language } = useLanguage();
  const id = useId();
  const say = (zh: string, en: string) => localized(language, zh, en);
  const en = language === "en-US";
  const device = findDevice(draft.device);
  const template = draft.template ?? device.template;
  const visualizer = draft.visualizer ?? device.visualizer;
  const templateLabel = findTemplate(device.template)?.label;
  const vizLabel = VISUALIZERS.find((entry) => entry.id === device.visualizer)?.label;
  const pickerAccent = /^#[0-9a-f]{6}$/i.test(draft.accentColor)
    ? draft.accentColor
    : (findTemplate(template)?.tokens.accent ?? "#c6f432");
  return (
    <>
      <Field
        label={say("设计模板", "Design template")}
        hint={
          draft.template ? (
            <button type="button" className="linkButton" onClick={() => onChange({ template: null })}>
              {say("跟随设备默认", "Follow the device default")}
              {templateLabel ? ` (${en ? templateLabel.en : templateLabel.zh})` : ""}
            </button>
          ) : (
            say("目前跟随设备默认。", "Following the device default for now.")
          )
        }
      >
        <TemplatePicker value={template} onSelect={(next) => onChange({ template: next })} />
        <label className="studioCheck">
          <input
            type="checkbox"
            checked={draft.templateSwitching}
            onChange={(event) => onChange({ templateSwitching: event.currentTarget.checked })}
          />
          {say("允许使用者在设置里换外观", "Let people pick their own look in Settings")}
        </label>
      </Field>
      <Field
        label={say("强调色", "Accent colour")}
        htmlFor={`${id}-accent`}
        hint={say("留空则使用模板自带的颜色。", "Leave empty to use the template's own colour.")}
        error={errors.accentColor}
      >
        <div className="accentRow">
          <input
            className="accentSwatch"
            type="color"
            value={pickerAccent.toLowerCase()}
            aria-label={say("选择颜色", "Pick a colour")}
            onChange={(event) => onChange({ accentColor: event.currentTarget.value.toUpperCase() })}
          />
          <input
            id={`${id}-accent`}
            className="studioInput mono"
            value={draft.accentColor}
            placeholder={pickerAccent.toUpperCase()}
            maxLength={7}
            spellCheck={false}
            aria-invalid={errors.accentColor ? true : undefined}
            onChange={(event) => onChange({ accentColor: event.currentTarget.value.trim() })}
          />
          {draft.accentColor ? (
            <button type="button" className="linkButton" onClick={() => onChange({ accentColor: "" })}>
              {say("用模板颜色", "Use the template's")}
            </button>
          ) : null}
        </div>
      </Field>
      <Field
        label={say("语音显示", "Voice display")}
        hint={
          draft.visualizer ? (
            <button type="button" className="linkButton" onClick={() => onChange({ visualizer: null })}>
              {say("跟随设备默认", "Follow the device default")}
              {vizLabel ? ` (${en ? vizLabel.en : vizLabel.zh})` : ""}
            </button>
          ) : (
            say("目前跟随设备默认。", "Following the device default for now.")
          )
        }
      >
        <VisualizerPicker value={visualizer} onSelect={(next) => onChange({ visualizer: next })} />
      </Field>
      <LogoField deviceId={draft.device} logo={logo} />
    </>
  );
}

export function SoundFields({ draft, onChange, errors, equalizer }: FieldProps & { equalizer: VoiceEqualizerOptions }) {
  const { language } = useLanguage();
  const device = findDevice(draft.device);
  // "Reset" in the panel means: back to what this device sounds like.
  const options = { ...equalizer, adjustable: true, default: { preset: device.equalizer } };
  return (
    <Field
      label={localized(language, "均衡器", "Equaliser")}
      hint={localized(
        language,
        "中继在发出语音前应用均衡，所有设备听到的都一样。",
        "The relay applies it to the voice before it leaves, so every device hears the same sound."
      )}
      error={errors.equalizer}
    >
      <VoiceEqualizerPanel
        options={options}
        value={draft.equalizer}
        onChange={(next) => onChange({ equalizer: next })}
        enabled
        onEnabledChange={() => {}}
        showPower={false}
      />
    </Field>
  );
}

function backendPlace(backend: BackendInfo, language: "zh-CN" | "en-US") {
  if (backend.place === "local") return localized(language, "本地运行，无需密钥", "Runs on your hardware, no key");
  if (backend.place === "demo") return localized(language, "无需密钥", "No key");
  return localized(language, "云端，需要 API 密钥", "Cloud, needs an API key");
}

/** Configurator: choose the backend and see exactly which .env keys it needs. */
export function BackendChooser({ draft, onChange }: Pick<FieldProps, "draft" | "onChange">) {
  const { language } = useLanguage();
  const name = useId();
  const en = language === "en-US";
  return (
    <Field
      label={localized(language, "语音后端", "Voice backend")}
      hint={localized(
        language,
        "密钥写在你自己机器上的 .env 里，这个页面不会要你输入。中继运行后，也可以在应用的「管理 → 助手工作室」里填写。",
        "Keys go in the .env file on your own machine; this page never asks you to type one. Once your relay is running, you can also enter them in the app under Admin → Studio."
      )}
    >
      <fieldset className="backendChoices">
        <legend className="visuallyHidden">{localized(language, "语音后端", "Voice backend")}</legend>
        {BACKENDS.map((backend) => {
          const selected = backend.id === draft.voiceProvider;
          return (
            <label key={backend.id} className={`backendChoice${selected ? " active" : ""}`}>
              <input
                className="visuallyHidden"
                type="radio"
                name={name}
                value={backend.id}
                checked={selected}
                onChange={() => onChange({ voiceProvider: backend.id })}
              />
              <span className="backendChoiceHead">
                <strong>{backend.label}</strong>
                <span className={`backendPlace ${backend.place}`}>{backendPlace(backend, language)}</span>
              </span>
              <span className="backendChoiceText">{en ? backend.description.en : backend.description.zh}</span>
              {backend.env.length ? <code className="backendEnv">{backend.env.join("  ")}</code> : null}
            </label>
          );
        })}
      </fieldset>
    </Field>
  );
}
