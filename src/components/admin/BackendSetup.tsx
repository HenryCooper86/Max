import { CaretDown, CheckCircle, WarningCircle } from "@phosphor-icons/react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ApiResult } from "../../lib/api-client";
import { localized } from "../../lib/i18n";
import {
  fetchStudioBackends,
  saveStudioBackends,
  type BackendFieldState,
  type BackendSetupState,
  type StudioBackends,
  type StudioBackendsUpdate
} from "../../lib/studio-api";
import { useLanguage } from "../LanguageToggle";

type Api = { fetchStudioBackends: typeof fetchStudioBackends; saveStudioBackends: typeof saveStudioBackends };
const DEFAULT_API: Api = { fetchStudioBackends, saveStudioBackends };

type Notice = { kind: "saved" | "error"; message: string } | null;

/** One field of a backend. Secrets are write-only: the input starts empty,
 *  never shows the stored key, and is cleared once a save succeeds. */
function BackendField({
  field,
  edit,
  onEdit
}: {
  field: BackendFieldState;
  /** undefined: unchanged; null: remove on save; string: new value. */
  edit: string | null | undefined;
  onEdit: (value: string | null | undefined) => void;
}) {
  const { language } = useLanguage();
  const say = (zh: string, en: string) => localized(language, zh, en);
  const id = useId();
  const fromEnv = field.source === "env";
  const removable = field.source === "studio" && edit !== null;
  const note =
    edit === null
      ? say(
          "保存后移除，改回服务器 .env 中的值（如有）。",
          "Removed when you save; falls back to the server's .env, if it has one."
        )
      : fromEnv
        ? say("来自服务器的 .env", "From the server's .env")
        : undefined;

  let control;
  if (field.kind === "toggle") {
    const on = (edit ?? field.value) === "on";
    control = (
      <button
        type="button"
        role="switch"
        id={id}
        aria-checked={on}
        className={`studioSwitch${on ? " on" : ""}`}
        onClick={() => onEdit(on ? "off" : "on")}
      >
        <span aria-hidden="true" />
        {on ? say("开", "On") : say("关", "Off")}
      </button>
    );
  } else if (field.kind === "secret") {
    control = (
      <input
        id={id}
        className="studioInput"
        type="password"
        autoComplete="new-password"
        spellCheck={false}
        value={typeof edit === "string" ? edit : ""}
        placeholder={
          field.set
            ? say("已设置，输入新的密钥即可替换", "Set — enter a new key to replace")
            : (field.placeholder ?? "")
        }
        onChange={(event) => onEdit(event.currentTarget.value || undefined)}
      />
    );
  } else {
    const original = field.value ?? "";
    control = (
      <input
        id={id}
        className="studioInput"
        type={field.kind === "url" ? "url" : "text"}
        autoComplete="off"
        spellCheck={false}
        value={typeof edit === "string" ? edit : edit === null ? "" : original}
        placeholder={field.placeholder ?? ""}
        onChange={(event) => {
          const next = event.currentTarget.value;
          onEdit(next === original ? undefined : next);
        }}
      />
    );
  }

  return (
    <div className="backendField">
      <label htmlFor={id}>
        {field.label} <code>{field.env}</code>
      </label>
      <div className="backendFieldControl">
        {control}
        {removable ? (
          <button type="button" className="studioButton quiet" onClick={() => onEdit(null)}>
            {say("移除", "Remove")}
          </button>
        ) : null}
        {edit === null ? (
          <button type="button" className="studioButton quiet" onClick={() => onEdit(undefined)}>
            {say("撤销", "Undo")}
          </button>
        ) : null}
      </div>
      {note ? <p className="studioHint">{note}</p> : null}
    </div>
  );
}

function BackendCard({
  backend,
  onSave
}: {
  backend: BackendSetupState;
  onSave: (values: Record<string, string | null>) => Promise<Notice>;
}) {
  const { language } = useLanguage();
  const say = (zh: string, en: string) => localized(language, zh, en);
  // Only what the admin changed, per env name. Lives for this form only.
  const [edits, setEdits] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const changed = Object.keys(edits).length > 0;

  const edit = (env: string, value: string | null | undefined) => {
    setNotice(null);
    setEdits((current) => {
      const next = { ...current };
      if (value === undefined) delete next[env];
      else next[env] = value;
      return next;
    });
  };

  return (
    <details className="backendCard">
      <summary>
        <span className="backendCardTitle">
          <strong>{backend.label}</strong>
          {backend.local ? <span className="backendKind local">{say("本地", "Local")}</span> : null}
        </span>
        {backend.configured ? (
          <span className="backendState ready">
            <CheckCircle size={16} weight="fill" aria-hidden="true" /> {say("已配置", "Set up")}
          </span>
        ) : (
          <span className="backendState missing">
            <WarningCircle size={16} aria-hidden="true" /> {say("需要", "Needs")} <code>{backend.requires}</code>
          </span>
        )}
        <CaretDown className="backendCardCaret" size={16} aria-hidden="true" />
      </summary>
      <div className="backendCardBody">
        <p className="studioHint">{backend.description}</p>
        {backend.fields.length === 0 ? (
          <p className="studioHint">{say("不需要任何设置。", "Nothing to set up.")}</p>
        ) : (
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              if (!changed) return;
              setBusy(true);
              const result = await onSave(edits);
              setBusy(false);
              setNotice(result);
              // A saved key leaves the page: the inputs start empty again.
              if (result?.kind === "saved") setEdits({});
            }}
          >
            {backend.fields.map((field) => (
              <BackendField
                key={field.env}
                field={field}
                edit={field.env in edits ? edits[field.env] : undefined}
                onEdit={(value) => edit(field.env, value)}
              />
            ))}
            <div className="backendCardActions">
              {notice ? (
                <p className={`studioStatus ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>
                  {notice.message}
                </p>
              ) : (
                <span />
              )}
              <button type="submit" className="studioButton" disabled={!changed || busy}>
                {busy ? say("保存中…", "Saving…") : say("保存这个后端", "Save this backend")}
              </button>
            </div>
          </form>
        )}
      </div>
    </details>
  );
}

/**
 * Studio → Voice backends: set up a backend's keys and options on the relay
 * instead of in its .env file, pick the default, and decide whether wearers
 * may switch. Keys are write-only from here.
 */
export function BackendSetup({
  onSaved,
  onAuthenticationExpired,
  api = DEFAULT_API
}: {
  /** Called after a change reaches the relay so /health is refetched. */
  onSaved: () => void;
  onAuthenticationExpired: () => void;
  api?: Api;
}) {
  const { language } = useLanguage();
  const say = useCallback((zh: string, en: string) => localized(language, zh, en), [language]);
  const [state, setState] = useState<StudioBackends | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [revision, setRevision] = useState(0);
  const selectId = useId();
  // The parent's callback may change identity every render; loading must
  // not repeat because of it.
  const expired = useRef(onAuthenticationExpired);
  useEffect(() => {
    expired.current = onAuthenticationExpired;
  });

  useEffect(() => {
    let active = true;
    void api.fetchStudioBackends().then((result) => {
      if (!active) return;
      if (result.ok) setState(result.data);
      else {
        if (result.error.kind === "unauthorized") expired.current();
        setLoadError(result.error.message);
      }
    });
    return () => {
      active = false;
    };
  }, [api]);

  const apply = useCallback(
    async (update: StudioBackendsUpdate, success: string): Promise<Notice> => {
      const result: ApiResult<StudioBackends> = await api.saveStudioBackends(update);
      if (!result.ok) {
        if (result.error.kind === "unauthorized") onAuthenticationExpired();
        return { kind: "error", message: result.error.message };
      }
      // Refetch so what the relay now reports (configured flags, sources) is
      // what is shown, then let the app pick up the new /health.
      const fresh = await api.fetchStudioBackends();
      setState(fresh.ok ? fresh.data : result.data);
      onSaved();
      return { kind: "saved", message: success };
    },
    [api, onAuthenticationExpired, onSaved]
  );

  if (loadError) {
    return (
      <p className="studioError" role="alert">
        <WarningCircle size={16} aria-hidden="true" /> {loadError}
      </p>
    );
  }
  if (!state) return <p className="studioHint">{say("正在读取语音后端…", "Loading the voice backends…")}</p>;

  const general = async (update: StudioBackendsUpdate) => {
    setNotice(await apply(update, say("已保存。", "Saved.")));
    setRevision((value) => value + 1);
  };

  return (
    <div className="backendSetup">
      <p className="studioHint">
        {say(
          "密钥保存在中继上，只有所有者能读取；保存后不会再显示，重新部署也不会被清除。",
          "Keys are stored on the relay with owner-only file permissions. They are never shown again, and a deploy does not erase them."
        )}
      </p>

      <div className="backendGeneral" key={revision}>
        <div className="studioField">
          <label className="studioLabel" htmlFor={selectId}>
            {say("默认后端", "Default backend")}
          </label>
          <select
            id={selectId}
            className="studioSelect"
            value={state.defaultProvider}
            onChange={(event) => void general({ defaultProvider: event.currentTarget.value })}
          >
            {state.backends.map((backend) => (
              <option key={backend.id} value={backend.id} disabled={!backend.configured}>
                {backend.label}
                {backend.configured ? "" : say("（未配置）", " (not set up)")}
              </option>
            ))}
          </select>
          <p className="studioHint">
            {say("只能选择已配置的后端。", "Only backends that are set up can be the default.")}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={state.switching}
          className={`studioSwitch${state.switching ? " on" : ""}`}
          onClick={() => void general({ switching: !state.switching })}
        >
          <span aria-hidden="true" />
          {say("允许使用者自己选择后端", "Let wearers choose their own backend")}
        </button>
        {notice ? (
          <p className={`studioStatus ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>
            {notice.message}
          </p>
        ) : null}
      </div>

      <div className="backendCards">
        {state.backends.map((backend) => (
          <BackendCard
            key={backend.id}
            backend={backend}
            onSave={(values) => apply({ values }, say("已保存。", "Saved."))}
          />
        ))}
      </div>
    </div>
  );
}
