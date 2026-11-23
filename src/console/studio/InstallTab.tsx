import "./install-tab.css";
import { useId, useState, type KeyboardEvent } from "react";
import { STUDIO_LIMITS, normalizeOrigin, type WidgetPosition } from "../../../shared/cloud-studio";
import { CopyButton } from "../CopyButton";
import { useSay } from "../hooks";
import { FRAMEWORKS, frameworkSnippets, mintTokenCurl, publicEmbedSnippet, type Framework } from "./install-snippets";
import type { StudioTabProps } from "./types";

const FRAMEWORK_LABELS: Record<Framework, string> = {
  html: "HTML + JS",
  react: "React",
  next: "Next.js",
  express: "Express",
  flask: "Flask"
};

export function InstallTab(props: StudioTabProps) {
  const { project, draft, updateStudio, dirty, origin } = props;
  const say = useSay();
  const ids = useId();
  const [framework, setFramework] = useState<Framework>("html");
  const [invalid, setInvalid] = useState<Record<number, boolean>>({});

  const embed = draft.studio.publicEmbed;
  const widget = draft.studio.widget;
  const savedOn = project.studio.publicEmbed.enabled;

  const setOrigins = (origins: string[]) => updateStudio({ publicEmbed: { ...embed, origins } });
  const setWidget = (patch: Partial<typeof widget>) => updateStudio({ widget: { ...widget, ...patch } });

  const commitOrigin = (index: number, raw: string) => {
    const next = [...embed.origins];
    if (!raw.trim()) {
      setInvalid((old) => ({ ...old, [index]: false }));
      return;
    }
    const normalized = normalizeOrigin(raw);
    setInvalid((old) => ({ ...old, [index]: !normalized }));
    if (normalized) next[index] = normalized;
    setOrigins(next);
  };

  const snippet = publicEmbedSnippet(origin, project.publicId, widget);
  const code = frameworkSnippets(framework, origin);
  const accent = /^#[0-9a-f]{6}$/i.test(widget.accent) ? widget.accent : "#2fd08a";
  const label = widget.label.trim() || say("和我们聊聊", "Talk to us");

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = FRAMEWORKS[(FRAMEWORKS.indexOf(framework) + step + FRAMEWORKS.length) % FRAMEWORKS.length]!;
    setFramework(next);
    document.getElementById(`${ids}-tab-${next}`)?.focus();
  };

  const block = (title: string, text: string) => (
    <>
      <div className="cxsInstallCodeHead">
        <span>{title}</span>
        <CopyButton text={text} />
      </div>
      <pre className="cxsInstallCode" tabIndex={0}>
        <code>{text}</code>
      </pre>
    </>
  );

  return (
    <div className="cxsInstall">
      <section className="cxsInstallHero" aria-labelledby={`${ids}-easy`}>
        <h3 id={`${ids}-easy`}>
          {say("最简单：粘贴一行代码（不需要后端）", "Easiest: paste one line (no backend needed)")}
        </h3>
        <label className="cxsInstallToggle">
          <input
            type="checkbox"
            checked={embed.enabled}
            onChange={(event) => updateStudio({ publicEmbed: { ...embed, enabled: event.target.checked } })}
          />
          <span>{say("允许在下面的网站上直接使用", "Let the websites below use this agent directly")}</span>
        </label>
        <p className="cxMuted">
          {say(
            "任何访问这些网站的人都能和你的智能体通话，并消耗你的分钟数。同时最多 3 场对话，每个访客最多 2 场。想控制花费，请在“设置”里设定每月分钟上限。",
            "Anyone visiting these websites can talk to your agent, and it uses your minutes. At most 3 conversations at once, 2 per visitor. To cap what it can spend, set a monthly minutes limit in Settings."
          )}
        </p>
        <div role="group" aria-labelledby={`${ids}-sites`}>
          <strong id={`${ids}-sites`}>{say("网站", "Websites")}</strong>
          <ul className="cxsInstallOrigins">
            {embed.origins.map((entry, index) => (
              <li key={index} className="cxsInstallOrigin">
                <input
                  type="text"
                  inputMode="url"
                  aria-label={say(`网站 ${index + 1}`, `Website ${index + 1}`)}
                  aria-invalid={invalid[index] ? true : undefined}
                  placeholder="https://example.com"
                  value={entry}
                  onChange={(event) => {
                    const next = [...embed.origins];
                    next[index] = event.target.value;
                    setOrigins(next);
                  }}
                  onBlur={(event) => commitOrigin(index, event.target.value)}
                />
                <button
                  type="button"
                  className="siteButton quiet small"
                  onClick={() => {
                    setOrigins(embed.origins.filter((_, at) => at !== index));
                    setInvalid({});
                  }}
                >
                  {say("移除", "Remove")}
                </button>
                {invalid[index] ? (
                  <p className="cxsInstallHint" role="alert">
                    {say(
                      "这不像网站地址。请用 https://example.com 这样的格式。",
                      "That does not look like a website address. Use something like https://example.com."
                    )}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="siteButton secondary small"
            disabled={embed.origins.length >= STUDIO_LIMITS.origins}
            onClick={() => setOrigins([...embed.origins, ""])}
          >
            {say("添加网站", "Add a website")}
          </button>
          <p className="cxMuted">
            {say(
              "开发时请加上 http://localhost:5173（或你的开发地址）。",
              "Add http://localhost:5173 (or your dev address) while you build."
            )}
          </p>
        </div>
        {dirty || !savedOn ? (
          <p className="cxWarn" role="status">
            {embed.enabled || dirty
              ? say("先保存才会生效。", "Save to turn this on.")
              : say("先开启并保存才会生效。", "Turn it on and save to make it work.")}
          </p>
        ) : null}
        {block(say("粘贴到你网页的 </body> 之前", "Paste before </body> on your page"), snippet)}
      </section>

      <section aria-labelledby={`${ids}-look`}>
        <h3 id={`${ids}-look`}>{say("外观", "Look")}</h3>
        <div className="cxsInstallLook">
          <div>
            <div className="cxField">
              <label htmlFor={`${ids}-label`}>
                <span>{say("按钮文字", "Button label")}</span>
              </label>
              <input
                id={`${ids}-label`}
                type="text"
                maxLength={STUDIO_LIMITS.label}
                value={widget.label}
                placeholder={say("和我们聊聊", "Talk to us")}
                onChange={(event) => setWidget({ label: event.target.value })}
              />
            </div>
            <div className="cxField">
              <label htmlFor={`${ids}-accent`}>
                <span>{say("主色", "Accent color")}</span>
              </label>
              <div className="cxsInstallColor">
                <input
                  type="color"
                  aria-label={say("选择颜色", "Pick a color")}
                  value={accent}
                  onChange={(event) => setWidget({ accent: event.target.value })}
                />
                <input
                  id={`${ids}-accent`}
                  type="text"
                  maxLength={7}
                  placeholder="#2fd08a"
                  value={widget.accent}
                  onChange={(event) => setWidget({ accent: event.target.value })}
                />
              </div>
            </div>
            <div className="cxField">
              <label htmlFor={`${ids}-position`}>
                <span>{say("位置", "Position")}</span>
              </label>
              <select
                id={`${ids}-position`}
                value={widget.position}
                onChange={(event) => setWidget({ position: event.target.value as WidgetPosition })}
              >
                <option value="bottom-right">{say("右下角", "Bottom right")}</option>
                <option value="bottom-left">{say("左下角", "Bottom left")}</option>
              </select>
            </div>
          </div>
          <div className="cxsInstallPreview" role="img" aria-label={say("按钮预览", "Button preview")}>
            <span className="cxsInstallFab" data-position={widget.position} style={{ background: accent }}>
              {label}
            </span>
          </div>
        </div>
      </section>

      <section aria-labelledby={`${ids}-backend`}>
        <h3 id={`${ids}-backend`}>{say("用你自己的后端（更多控制）", "With your own backend (more control)")}</h3>
        <p className="cxMuted">
          {say(
            "适合这些情况：你知道用户是谁、想传入 userId 或 context、或不想公开智能体。你的后端用项目密钥换取短期令牌，浏览器只拿到令牌。",
            "Use this when you know who the user is, want to pass userId or context, or do not want a public agent. Your server trades the project key for a short-lived token, and the browser only gets the token."
          )}
        </p>
        <p className="cxMuted">
          {say(
            "项目密钥（mpk_…）放在环境变量 MAX_PROJECT_KEY 里，绝不要放进浏览器。",
            "Keep the project key (mpk_…) in the MAX_PROJECT_KEY environment variable, never in the browser."
          )}
        </p>
        <div role="tablist" aria-label={say("选择框架", "Choose a framework")} className="cxsInstallTabs">
          {FRAMEWORKS.map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              id={`${ids}-tab-${name}`}
              aria-selected={framework === name}
              aria-controls={`${ids}-panel`}
              tabIndex={framework === name ? 0 : -1}
              onClick={() => setFramework(name)}
              onKeyDown={onTabKey}
            >
              {FRAMEWORK_LABELS[name]}
            </button>
          ))}
        </div>
        <div role="tabpanel" id={`${ids}-panel`} aria-labelledby={`${ids}-tab-${framework}`}>
          {code.install ? block(say("安装", "Install"), code.install) : null}
          {block(say(`服务端：${code.serverFile}`, `Server: ${code.serverFile}`), code.server)}
          {block(say(`浏览器：${code.clientFile}`, `Browser: ${code.clientFile}`), code.client)}
          {framework === "react" || framework === "next" ? (
            <p className="cxMuted">
              {say("先执行 npm install max-voice-agent。", "Run npm install max-voice-agent first.")}
            </p>
          ) : null}
          {block(say("或直接用 curl 试一下", "Or try it with curl"), mintTokenCurl(origin))}
        </div>
      </section>
    </div>
  );
}
