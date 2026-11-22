import { ClockCounterClockwise } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { localized, type Language } from "../../lib/i18n";
import {
  fetchStudioHistory,
  restoreStudioVersion,
  type StudioRestored,
  type StudioVersion
} from "../../lib/studio-api";
import { useLanguage } from "../LanguageToggle";

const SHOWN_AT_FIRST = 6;

function when(timestamp: number, language: Language): string {
  return new Intl.DateTimeFormat(language === "en-US" ? "en-US" : "zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(timestamp));
}

const DEFAULT_API = { fetchStudioHistory, restoreStudioVersion };

type Props = {
  /** Changes whenever the config on the relay has changed, so the list is read again. */
  revision: number;
  /** True while the Studio has unsaved edits: a restore discards them, and says so first. */
  unsaved: boolean;
  disabled: boolean;
  onRestored: (state: StudioRestored) => void;
  onAuthenticationExpired: () => void;
  /** Injected in tests. */
  api?: typeof DEFAULT_API;
};

/**
 * Admin → Studio → History: the assistant configs that have been live on this
 * relay, newest first, and a way back to any of them.
 */
export function ConfigHistory({
  revision,
  unsaved,
  disabled,
  onRestored,
  onAuthenticationExpired,
  api = DEFAULT_API
}: Props) {
  const { language } = useLanguage();
  const say = useCallback((zh: string, en: string) => localized(language, zh, en), [language]);
  const [versions, setVersions] = useState<StudioVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void api.fetchStudioHistory().then((result) => {
      if (!active) return;
      if (result.ok) {
        setVersions(result.data.versions);
        setError(null);
      } else {
        if (result.error.kind === "unauthorized") onAuthenticationExpired();
        setError(result.error.message);
      }
    });
    return () => {
      active = false;
    };
    // Read again whenever the relay's config changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, revision]);

  const who = (by: string) =>
    by === "file"
      ? say("服务器上的配置文件", "the config file on the server")
      : by === "studio"
        ? say("管理后台", "the Studio")
        : by;

  const restore = async (version: StudioVersion) => {
    const time = when(version.savedAt, language);
    const question =
      say(
        `恢复到 ${time} 的配置？新的会话会立即使用它。`,
        `Go back to the settings of ${time}? New sessions use them from then on.`
      ) + (unsaved ? say(" 未保存的修改会丢失。", " Your unsaved changes are lost.") : "");
    if (!window.confirm(question)) return;
    setRestoring(version.id);
    const result = await api.restoreStudioVersion(version.id);
    setRestoring(null);
    if (result.ok) {
      setError(null);
      onRestored(result.data);
      return;
    }
    if (result.error.kind === "unauthorized") onAuthenticationExpired();
    setError(result.error.message);
  };

  const shown = versions ? (showAll ? versions : versions.slice(0, SHOWN_AT_FIRST)) : [];

  return (
    <section className="studioHistory" aria-labelledby="studio-history">
      <h3 id="studio-history">{say("历史版本", "History")}</h3>
      <p className="studioHistoryNote">
        {say(
          "这台中继用过的助手配置，最新的在前，保留最近 50 份。恢复会换回整份配置，包括这里不能编辑的工具、规则和知识库设置。",
          "The assistant settings this relay has run, newest first; the last 50 are kept. Going back brings the whole config with it, including the tools, rules and knowledge settings that are not edited here."
        )}
      </p>
      {error ? (
        <p className="studioHistoryError" role="alert">
          {error}
        </p>
      ) : null}
      {versions === null && !error ? <p role="status">{say("正在读取历史版本…", "Loading the history…")}</p> : null}
      {versions !== null && versions.length === 0 ? (
        <p>
          {say(
            "还没有历史版本。保存一次之后，这里会列出每一份配置。",
            "Nothing yet. Each config is listed here from the first save on."
          )}
        </p>
      ) : null}
      {shown.length > 0 ? (
        <ol className="studioHistoryList">
          {shown.map((version) => (
            <li key={version.id} className={version.current ? "current" : ""}>
              <div className="studioHistoryWhat">
                <strong>
                  <time dateTime={new Date(version.savedAt).toISOString()}>{when(version.savedAt, language)}</time>
                  {version.name ? ` · ${version.name}` : ""}
                  {version.version ? ` · ${version.version}` : ""}
                </strong>
                <span>
                  {say("来自", "By ")}
                  {who(version.by)}
                  {version.restoredFrom ? say("（恢复的旧版本）", " (an earlier version, restored)") : ""}
                  {version.changed.length > 0 ? say("；修改了 ", "; changed ") : ""}
                  {version.changed.map((key, index) => (
                    <span key={key}>
                      {index > 0 ? ", " : ""}
                      <code>{key}</code>
                    </span>
                  ))}
                </span>
              </div>
              {version.current ? (
                <span className="studioHistoryCurrent">{say("当前", "Current")}</span>
              ) : (
                <button
                  type="button"
                  className="studioButton quiet"
                  disabled={disabled || restoring !== null}
                  onClick={() => void restore(version)}
                >
                  <ClockCounterClockwise size={16} aria-hidden="true" />{" "}
                  {restoring === version.id ? say("恢复中…", "Restoring…") : say("恢复", "Restore")}
                </button>
              )}
            </li>
          ))}
        </ol>
      ) : null}
      {versions && versions.length > SHOWN_AT_FIRST && !showAll ? (
        <button type="button" className="linkButton" onClick={() => setShowAll(true)}>
          {say(`显示全部 ${versions.length} 份`, `Show all ${versions.length}`)}
        </button>
      ) : null}
    </section>
  );
}
