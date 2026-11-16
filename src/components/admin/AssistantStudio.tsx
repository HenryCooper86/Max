import { ArrowCounterClockwise, CheckCircle, Circle, FloppyDisk } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  configFromDraft,
  draftFromConfig,
  hasErrors,
  sameConfig,
  validateDraft,
  type AssistantDraft
} from "../../lib/assistant-config";
import { brandLogoPath } from "../../lib/assistant";
import { findDevice } from "../../lib/device-catalog";
import { localized, type Language } from "../../lib/i18n";
import { APP_PATH } from "../../lib/routes";
import {
  fetchStudio,
  removeStudioLogo,
  saveStudio,
  STUDIO_LOGO_MAX_BYTES,
  uploadStudioLogo,
  type StudioState
} from "../../lib/studio-api";
import type { ApiResult } from "../../lib/api-client";
import { useLanguage } from "../LanguageToggle";
import { DeviceFields, IdentityFields, LookFields, SoundFields, type LogoControls } from "../studio/AssistantFields";
import { AssistantPreview } from "../studio/AssistantPreview";
import { BackendSetup } from "./BackendSetup";

/** Cancelable event the workspace sends before switching section. */
export const SECTION_LEAVE_EVENT = "admin:beforesection";

/** The draft an admin starts from. A relay on its defaults has an empty
 *  stored config; the draft then shows what is running (its name, device and
 *  languages) so saving without changes keeps the same assistant. */
function draftFromStudio(state: StudioState, language: Language): AssistantDraft {
  if (Object.keys(state.config).length) return draftFromConfig(state.config, language);
  return draftFromConfig(
    { name: state.assistant.name, device: state.assistant.deviceProfile, languages: state.assistant.languages },
    language
  );
}

type Status = { kind: "idle" | "saved" | "error"; message?: string };

type Props = {
  /** Called after any change reaches the relay, so the app can refetch
   *  /health and rebrand at once. */
  onSaved: () => void;
  onAuthenticationExpired: () => void;
  /** Injected in tests. */
  backendApi?: Parameters<typeof BackendSetup>[0]["api"];
  api?: {
    fetchStudio: typeof fetchStudio;
    saveStudio: typeof saveStudio;
    uploadStudioLogo: typeof uploadStudioLogo;
    removeStudioLogo: typeof removeStudioLogo;
  };
};

const DEFAULT_API = { fetchStudio, saveStudio, uploadStudioLogo, removeStudioLogo };

/**
 * Admin → Studio: edit the running relay's assistant with the configurator's
 * controls and a live preview. Saves apply to new sessions and /health at
 * once. API keys are never shown or edited here.
 */
export function AssistantStudio({ onSaved, onAuthenticationExpired, api = DEFAULT_API, backendApi }: Props) {
  const { language } = useLanguage();
  const say = useCallback((zh: string, en: string) => localized(language, zh, en), [language]);
  const [studio, setStudio] = useState<StudioState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saved, setSaved] = useState<AssistantDraft | null>(null);
  const [draft, setDraft] = useState<AssistantDraft | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [logoError, setLogoError] = useState<string | undefined>();
  const [showErrors, setShowErrors] = useState(false);

  const adopt = useCallback(
    (state: StudioState, keepDraft = false) => {
      setStudio(state);
      const next = draftFromStudio(state, language);
      setSaved(next);
      if (!keepDraft) {
        setDraft(next);
        setFormKey((key) => key + 1);
      }
    },
    [language]
  );

  const handle = useCallback(
    (result: ApiResult<StudioState>, success?: string) => {
      if (result.ok) {
        if (success) setStatus({ kind: "saved", message: success });
        return result.data;
      }
      if (result.error.kind === "unauthorized") onAuthenticationExpired();
      setStatus({ kind: "error", message: result.error.message });
      return null;
    },
    [onAuthenticationExpired]
  );

  useEffect(() => {
    let active = true;
    void api.fetchStudio().then((result) => {
      if (!active) return;
      if (result.ok) adopt(result.data);
      else {
        if (result.error.kind === "unauthorized") onAuthenticationExpired();
        setLoadError(result.error.message);
      }
    });
    return () => {
      active = false;
    };
    // Load once per mount; adopt changes with the language only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  const dirty = Boolean(draft && saved && !sameConfig(draft, saved));
  const errors = useMemo(() => (draft ? validateDraft(draft, language) : {}), [draft, language]);

  // Unsaved changes: confirm before the tab closes, the workspace closes, or
  // another section opens.
  useEffect(() => {
    if (!dirty) return;
    const message = say("放弃未保存的修改？", "Discard your unsaved changes?");
    const onUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    const onLeave = (event: Event) => {
      if (!event.defaultPrevented && !window.confirm(message)) event.preventDefault();
    };
    window.addEventListener("beforeunload", onUnload);
    window.addEventListener("admin:beforeleave", onLeave);
    window.addEventListener(SECTION_LEAVE_EVENT, onLeave);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      window.removeEventListener("admin:beforeleave", onLeave);
      window.removeEventListener(SECTION_LEAVE_EVENT, onLeave);
    };
  }, [dirty, say]);

  if (loadError) {
    return (
      <div className="adminSyncNotice error" role="alert">
        <strong>{say("无法读取助手配置", "Couldn't load the assistant's settings")}</strong>
        <span>{loadError}</span>
      </div>
    );
  }
  if (!studio || !draft || !saved) {
    return (
      <p className="adminWorkspaceLoading" role="status">
        {say("正在读取助手配置…", "Loading the assistant's settings…")}
      </p>
    );
  }

  const update = (patch: Partial<AssistantDraft>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
    setStatus({ kind: "idle" });
  };

  const save = async () => {
    setShowErrors(true);
    if (hasErrors(errors)) {
      setStatus({ kind: "error", message: say("先修正标出的地方再保存。", "Fix the marked fields, then save.") });
      return;
    }
    setBusy(true);
    const state = handle(
      await api.saveStudio(configFromDraft(draft)),
      say("已保存。新的会话会立即使用。", "Saved. New sessions use it from now on.")
    );
    setBusy(false);
    if (state) {
      adopt(state);
      setShowErrors(false);
      onSaved();
    }
  };

  const discard = () => {
    setDraft(saved);
    setFormKey((key) => key + 1);
    setShowErrors(false);
    setStatus({ kind: "idle" });
  };

  const resetToDefaults = async () => {
    if (
      !window.confirm(
        say(
          "把助手恢复为默认的 Max？这会清除保存的配置和上传的标志，无法撤销。",
          "Reset the assistant to the default Max? This clears the saved settings and any uploaded logo, and cannot be undone."
        )
      )
    )
      return;
    setBusy(true);
    let state = handle(await api.saveStudio({}));
    if (state?.customLogo) state = handle(await api.removeStudioLogo());
    setBusy(false);
    if (state) {
      adopt(state);
      setStatus({ kind: "saved", message: say("已恢复默认。", "Back to the defaults.") });
      onSaved();
    }
  };

  const logo: LogoControls = {
    customUrl: studio.customLogo ? brandLogoPath(studio.assistant.logoUrl) : undefined,
    busy,
    error: logoError,
    note: say(
      "正方形的 SVG 或 PNG，最大 512 KB。上传后立即生效，不需要保存。",
      "A square SVG or PNG, up to 512 KB. It takes effect as soon as it uploads; no need to save."
    ),
    onPick: async (file) => {
      if (file.size > STUDIO_LOGO_MAX_BYTES) {
        setLogoError(say("标志最大 512 KB。", "The logo must be 512 KB or smaller."));
        return;
      }
      if (!/^image\/(svg\+xml|png)$/.test(file.type)) {
        setLogoError(say("请选择 SVG 或 PNG 文件。", "Choose an SVG or PNG file."));
        return;
      }
      setLogoError(undefined);
      setBusy(true);
      const result = await api.uploadStudioLogo(file);
      setBusy(false);
      if (!result.ok) {
        if (result.error.kind === "unauthorized") onAuthenticationExpired();
        setLogoError(result.error.message);
        return;
      }
      adopt(result.data, true);
      setStatus({ kind: "saved", message: say("标志已更新。", "Logo updated.") });
      onSaved();
    },
    onRemove: async () => {
      setBusy(true);
      const state = handle(await api.removeStudioLogo(), say("已改回设备标志。", "Back to the device's mark."));
      setBusy(false);
      if (state) {
        adopt(state, true);
        onSaved();
      }
    }
  };

  const shownErrors = showErrors ? errors : { ...errors, name: draft.name.trim() ? errors.name : undefined };
  const device = findDevice(draft.device);
  const firstRun = Object.keys(studio.config).length === 0;
  const defaults = draftFromStudio({ ...studio, config: {} }, language);
  const checklist = [
    {
      done: draft.name.trim() !== "" && draft.name.trim() !== defaults.name,
      label: say("给助手起名", "Name your assistant")
    },
    { done: draft.device !== defaults.device, label: say("选择设备", "Choose the device") },
    {
      done: Boolean(draft.template || draft.visualizer || draft.accentColor),
      label: say("挑选外观", "Pick the look")
    },
    { done: draft.equalizer !== null, label: say("调整声音", "Tune the voice") },
    {
      done: studio.providers.some((provider) => provider.id !== "mock" && provider.configured),
      label: say("选择语音后端", "Choose a voice backend")
    }
  ];

  return (
    <div className="studio studioScope">
      {firstRun ? (
        <section className="studioChecklist" aria-labelledby="studio-checklist">
          <h3 id="studio-checklist">{say("让它成为你的助手", "Make it your assistant")}</h3>
          <p>
            {say(
              "中继现在运行的是默认的 Max。按顺序完成这些，然后保存。",
              "The relay is running the default Max. Work through these, then save."
            )}
          </p>
          <ol>
            {checklist.map((item) => (
              <li key={item.label} className={item.done ? "done" : ""}>
                {item.done ? (
                  <CheckCircle size={18} weight="fill" aria-hidden="true" />
                ) : (
                  <Circle size={18} aria-hidden="true" />
                )}
                <span>{item.label}</span>
                <span className="visuallyHidden">{item.done ? say("（已完成）", "(done)") : ""}</span>
              </li>
            ))}
            <li>
              <Circle size={18} aria-hidden="true" />
              <span>
                {say("戴到设备上：", "Put it on a device: ")}
                <a href={APP_PATH}>{say("打开网页应用", "open the web app")}</a>
                {say("，或参阅 README 中 iOS 与 Android 一节。", ", or see the iOS and Android notes in the README.")}
              </span>
            </li>
          </ol>
        </section>
      ) : null}

      <div className="studioLayout">
        <div className="studioForm" key={formKey}>
          <section aria-labelledby="studio-device">
            <h3 id="studio-device">{say("设备", "Device")}</h3>
            <DeviceFields draft={draft} onChange={update} errors={shownErrors} />
          </section>
          <section aria-labelledby="studio-identity">
            <h3 id="studio-identity">{say("身份", "Identity")}</h3>
            <IdentityFields draft={draft} onChange={update} errors={shownErrors} />
          </section>
          <section aria-labelledby="studio-look">
            <h3 id="studio-look">{say("外观", "Look")}</h3>
            <LookFields draft={draft} onChange={update} errors={shownErrors} logo={logo} />
          </section>
          <section aria-labelledby="studio-sound">
            <h3 id="studio-sound">{say("声音", "Sound")}</h3>
            <SoundFields draft={draft} onChange={update} errors={shownErrors} equalizer={studio.equalizer} />
          </section>
          <section aria-labelledby="studio-backend">
            <h3 id="studio-backend">{say("语音后端", "Voice backend")}</h3>
            <BackendSetup onSaved={onSaved} onAuthenticationExpired={onAuthenticationExpired} api={backendApi} />
          </section>
          <section className="studioDanger" aria-labelledby="studio-reset">
            <h3 id="studio-reset">{say("恢复默认", "Reset to defaults")}</h3>
            <p>
              {say(
                "清除保存的配置和上传的标志，回到默认的 Max。",
                "Clears the saved settings and any uploaded logo, and goes back to the default Max."
              )}
            </p>
            <button type="button" className="danger" disabled={busy} onClick={() => void resetToDefaults()}>
              <ArrowCounterClockwise size={16} aria-hidden="true" /> {say("恢复默认", "Reset to defaults")}
            </button>
          </section>
        </div>
        <aside className="studioPreview" aria-label={say("预览", "Preview")}>
          <AssistantPreview
            identity={{
              name: draft.name,
              device: draft.device,
              template: draft.template ?? device.template,
              visualizer: draft.visualizer ?? device.visualizer,
              accentColor: /^#[0-9a-f]{6}$/i.test(draft.accentColor) ? draft.accentColor : undefined,
              logoUrl: logo.customUrl
            }}
            compact
            label={say("助手预览（脚本演示）", "Assistant preview (scripted)")}
          />
          <p className="studioPreviewNote">
            {say(
              "预览播放预先写好的台词，不连接语音后端。",
              "The preview plays pre-written lines; it does not use the voice backend."
            )}
          </p>
        </aside>
      </div>

      <div className={`studioSaveBar${dirty ? " dirty" : ""}`} role="region" aria-label={say("保存", "Save")}>
        <p role="status" className={`studioStatus ${status.kind}`}>
          {status.message ??
            (dirty
              ? say("有未保存的修改。", "You have unsaved changes.")
              : say("没有未保存的修改。", "No unsaved changes."))}
        </p>
        <div className="studioSaveActions">
          <button type="button" disabled={!dirty || busy} onClick={discard}>
            {say("放弃修改", "Discard")}
          </button>
          <button type="button" className="primary" disabled={!dirty || busy} onClick={() => void save()}>
            <FloppyDisk size={16} aria-hidden="true" /> {busy ? say("保存中…", "Saving…") : say("保存", "Save")}
          </button>
        </div>
      </div>
    </div>
  );
}
