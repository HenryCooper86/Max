import { ArrowLeft, ArrowRight, DownloadSimple, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Mascot, type MascotMood } from "../components/Mascot";
import hummingbirdMark from "../../brand/hummingbird.svg?url";
import { useLanguage } from "../components/LanguageToggle";
import { AssistantPreview } from "../components/studio/AssistantPreview";
import {
  BackendChooser,
  DeviceFields,
  IdentityFields,
  LookFields,
  SoundFields,
  type LogoControls
} from "../components/studio/AssistantFields";
import {
  clearBuildDraft,
  configFileText,
  emptyDraft,
  envFileText,
  hasErrors,
  loadBuildDraft,
  saveBuildDraft,
  SETUP_COMMANDS,
  validateDraft,
  type AssistantDraft,
  type DraftField
} from "../lib/assistant-config";
import { BUILT_IN_EQUALIZER, findBackend, findDevice } from "../lib/device-catalog";
import { localized } from "../lib/i18n";
import { APP_PATH } from "../lib/routes";
import { CopyButton } from "./LandingPage";

type StepId = "device" | "identity" | "look" | "sound" | "backend" | "finish";
const STEPS: readonly StepId[] = ["device", "identity", "look", "sound", "backend", "finish"];
const STEP_FIELDS: Record<StepId, DraftField[]> = {
  device: ["device"],
  identity: ["name", "wakeNames", "languages", "developer", "tagline"],
  look: ["accentColor"],
  sound: ["equalizer"],
  backend: [],
  finish: []
};
const LOGO_MAX_BYTES = 512 * 1024;

function download(filename: string, text: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The public configurator: design an assistant with a live preview and take
 *  the files away. Nothing here is sent to a server; the draft is kept in
 *  this browser so a refresh does not lose it. */
/** What the bird does at each step. */
const STEP_MOODS: Record<StepId, MascotMood> = {
  device: "ready",
  identity: "listening",
  look: "happy",
  sound: "speaking",
  backend: "thinking",
  finish: "happy"
};

export function BuildPage() {
  const { language } = useLanguage();
  const say = (zh: string, en: string) => localized(language, zh, en);
  const [progress, setProgress] = useState(() => loadBuildDraft(language) ?? { draft: emptyDraft(language), step: 0 });
  const { draft, step } = progress;
  const stepId = STEPS[step] ?? "device";
  const errors = useMemo(() => validateDraft(draft, language), [draft, language]);
  const [logoUrl, setLogoUrl] = useState<string | undefined>();
  const [logoError, setLogoError] = useState<string | undefined>();
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Problems show for steps the visitor has already been through (and on
  // Finish), not for a field they have not reached yet.
  const [visited, setVisited] = useState<ReadonlySet<number>>(
    () => new Set(Array.from({ length: step }, (_, index) => index))
  );

  useEffect(() => saveBuildDraft(progress), [progress]);
  useEffect(() => () => (logoUrl ? URL.revokeObjectURL(logoUrl) : undefined), [logoUrl]);

  const update = (patch: Partial<AssistantDraft>) =>
    setProgress((current) => ({ ...current, draft: { ...current.draft, ...patch } }));
  const goTo = (next: number) => {
    setVisited((current) => new Set([...current, step]));
    setProgress((current) => ({ ...current, step: Math.max(0, Math.min(STEPS.length - 1, next)) }));
    window.requestAnimationFrame(() => headingRef.current?.focus());
  };

  const logo: LogoControls = {
    customUrl: logoUrl,
    error: logoError,
    note: logoUrl
      ? say(
          "只在这个页面预览，不会上传。把文件放进项目，配置里已写好它的路径。",
          "Previewed on this page only, never uploaded. Put the file in your project; the config already points at it."
        )
      : undefined,
    onPick: (file) => {
      if (file.size > LOGO_MAX_BYTES) {
        setLogoError(say("标志最大 512 KB。", "The logo must be 512 KB or smaller."));
        return;
      }
      if (!/^image\/(svg\+xml|png)$/.test(file.type)) {
        setLogoError(say("请选择 SVG 或 PNG 文件。", "Choose an SVG or PNG file."));
        return;
      }
      setLogoError(undefined);
      setLogoUrl(URL.createObjectURL(file));
      const safeName = file.name.replace(/[^\w.-]+/g, "-");
      update({ extra: { ...draft.extra, logo: `./${safeName}` } });
    },
    onRemove: () => {
      setLogoUrl(undefined);
      const { logo: _removed, ...rest } = draft.extra;
      void _removed;
      update({ extra: rest });
    }
  };

  const device = findDevice(draft.device);
  const stepTitles: Record<StepId, string> = {
    device: say("设备", "Device"),
    identity: say("身份", "Identity"),
    look: say("外观", "Look"),
    sound: say("声音", "Sound"),
    backend: say("语音后端", "Voice backend"),
    finish: say("完成", "Finish")
  };
  const stepLedes: Record<StepId, string> = {
    device: say(
      "助手戴在哪里？它会决定行为准则和默认的外观与声音。",
      "Where will it be worn? That sets its conduct and its default look and sound."
    ),
    identity: say("它叫什么、说什么语言、由谁制作。", "What it is called, which languages it speaks, and who made it."),
    look: say(
      "应用的模板、强调色、镜片里的语音显示和标志。",
      "The app's template, accent colour, the voice display in the lens, and the logo."
    ),
    sound: say("用预设或自己调十个频段。", "Pick a preset or set the ten bands yourself."),
    backend: say("由哪个模型来听和说。", "Which model listens and speaks."),
    finish: say("把这些文件带走，在你的机器上运行。", "Take these files to your own machine and run it.")
  };
  const stepHasError = (id: StepId) => STEP_FIELDS[id].some((field) => errors[field]);
  const finishing = stepId === "finish";
  const shownErrors = Object.fromEntries(
    Object.entries(errors).filter(
      ([field]) =>
        finishing || STEPS.some((id, index) => visited.has(index) && STEP_FIELDS[id].includes(field as DraftField))
    )
  );
  const flagStep = (id: StepId, index: number) => (finishing || visited.has(index)) && stepHasError(id);
  const configText = configFileText(draft);
  const envText = envFileText(draft);
  const backend = findBackend(draft.voiceProvider);

  return (
    <div className="buildPage studioScope">
      <header className="buildIntro">
        <h1>{say("配置你的助手", "Build your assistant")}</h1>
        <p>
          {say(
            "边改边看预览，最后得到 assistant.config.json 和 .env 需要的几行。内容只保存在这个浏览器里，不会发送到任何服务器。",
            "Change it and watch the preview, then take away an assistant.config.json and the .env lines it needs. Everything stays in this browser; nothing is sent to a server."
          )}
        </p>
      </header>

      <nav className="buildSteps" aria-label={say("步骤", "Steps")}>
        {/* --build-progress drives the line under the steps: how far through. */}
        <ol style={{ "--build-progress": (step + 1) / STEPS.length } as CSSProperties}>
          {STEPS.map((id, index) => (
            <li key={id}>
              <button
                type="button"
                className={`${index === step ? "active" : index < step ? "done" : ""}${flagStep(id, index) ? " invalid" : ""}`}
                aria-current={index === step ? "step" : undefined}
                onClick={() => goTo(index)}
              >
                <span className="buildStepNumber">{index + 1}</span>
                {stepTitles[id]}
                {flagStep(id, index) ? (
                  <WarningCircle size={14} aria-label={say("需要修改", "Needs attention")} />
                ) : null}
              </button>
            </li>
          ))}
        </ol>
      </nav>

      <div className="buildLayout">
        <section className="buildForm" aria-labelledby="build-step-title">
          <h2 id="build-step-title" ref={headingRef} tabIndex={-1}>
            {stepTitles[stepId]}
          </h2>
          {/* Keyed by step, so each step's rule and fields arrive afresh. */}
          <span key={`rule-${stepId}`} className="buildHeadingRule" aria-hidden="true" />
          <div key={stepId} className="buildStepBody">
            <p className="buildLede">{stepLedes[stepId]}</p>

            {stepId === "device" ? <DeviceFields draft={draft} onChange={update} errors={shownErrors} /> : null}
            {stepId === "identity" ? <IdentityFields draft={draft} onChange={update} errors={shownErrors} /> : null}
            {stepId === "look" ? <LookFields draft={draft} onChange={update} errors={shownErrors} logo={logo} /> : null}
            {stepId === "sound" ? (
              <SoundFields draft={draft} onChange={update} errors={shownErrors} equalizer={BUILT_IN_EQUALIZER} />
            ) : null}
            {stepId === "backend" ? <BackendChooser draft={draft} onChange={update} /> : null}
            {stepId === "finish" ? (
              <div className="buildFinish">
                {hasErrors(errors) ? (
                  <div className="buildProblems" role="alert">
                    <strong>{say("还有几处要改：", "A few things to fix first:")}</strong>
                    <ul>
                      {STEPS.filter(stepHasError).map((id) => (
                        <li key={id}>
                          <button type="button" className="linkButton" onClick={() => goTo(STEPS.indexOf(id))}>
                            {stepTitles[id]}
                          </button>
                          :{" "}
                          {STEP_FIELDS[id]
                            .map((field) => errors[field])
                            .filter(Boolean)
                            .join(" ")}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <div className="outputBlock">
                  <div className="outputHead">
                    <h3>assistant.config.json</h3>
                    <span className="outputActions">
                      <CopyButton text={configText} label={say("复制", "Copy")} />
                      <button
                        type="button"
                        className="siteButton small"
                        disabled={hasErrors(errors)}
                        onClick={() => download("assistant.config.json", configText)}
                      >
                        <DownloadSimple size={16} aria-hidden="true" />
                        {say("下载", "Download")}
                      </button>
                    </span>
                  </div>
                  <p className="outputNote">
                    {say(
                      "保存在项目根目录，和 package.json 放在一起。",
                      "Save it in the project folder, next to package.json."
                    )}
                  </p>
                  <pre>
                    <code>{configText}</code>
                  </pre>
                </div>
                <div className="outputBlock">
                  <div className="outputHead">
                    <h3>.env</h3>
                    <CopyButton text={envText} label={say("复制", "Copy")} />
                  </div>
                  <p className="outputNote">
                    {backend.env.length
                      ? say(
                          "把这几行加进 .env，并在你自己的机器上填入值。不要把密钥贴到任何网页里。",
                          "Add these lines to .env and fill in the values on your own machine. Never paste a key into a web page."
                        )
                      : say("这个后端不需要密钥。", "This backend needs no key.")}
                  </p>
                  <pre>
                    <code>{envText}</code>
                  </pre>
                </div>
                <div className="outputBlock">
                  <div className="outputHead">
                    <h3>{say("然后运行", "Then run")}</h3>
                    <CopyButton text={SETUP_COMMANDS.join("\n")} label={say("复制", "Copy")} />
                  </div>
                  <pre>
                    <code>{SETUP_COMMANDS.join("\n")}</code>
                  </pre>
                  <p className="outputNote">
                    {draft.extra.logo
                      ? say(
                          "放好标志文件后运行 npm run brand，生成网页、iOS 和 Android 的图标。",
                          "With your logo file in place, npm run brand writes the web, iOS and Android icons."
                        )
                      : say(
                          "之后可在应用的管理工作室里继续修改：",
                          "Later you can keep editing it from the Studio inside the app: "
                        )}
                    {draft.extra.logo ? null : <a href={APP_PATH}>{say("打开应用", "open the app")}</a>}
                  </p>
                </div>
                <button
                  type="button"
                  className="linkButton"
                  onClick={() => {
                    if (!window.confirm(say("清空这个草稿，重新开始？", "Clear this draft and start again?"))) return;
                    clearBuildDraft();
                    setLogoUrl(undefined);
                    setProgress({ draft: emptyDraft(language), step: 0 });
                  }}
                >
                  {say("清空草稿，重新开始", "Clear the draft and start again")}
                </button>
              </div>
            ) : null}
          </div>

          <div className="buildNav">
            {step > 0 ? (
              <button type="button" className="siteButton secondary" onClick={() => goTo(step - 1)}>
                <ArrowLeft size={16} aria-hidden="true" />
                {say("上一步", "Back")}
              </button>
            ) : (
              <span />
            )}
            {step < STEPS.length - 1 ? (
              <button type="button" className="siteButton" onClick={() => goTo(step + 1)}>
                {say("下一步：", "Next: ")}
                {stepTitles[STEPS[step + 1]!]}
                <ArrowRight size={16} aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </section>

        <aside className="buildPreview" aria-label={say("预览", "Preview")}>
          <AssistantPreview
            identity={{
              name: draft.name,
              device: draft.device,
              template: draft.template ?? device.template,
              visualizer: draft.visualizer ?? device.visualizer,
              accentColor: /^#[0-9a-f]{6}$/i.test(draft.accentColor) ? draft.accentColor : undefined,
              // Max's own mark until you upload yours.
              logoUrl: logoUrl ?? hummingbirdMark
            }}
            label={say("助手预览（脚本演示）", "Assistant preview (scripted)")}
          />
          <p className="buildPreviewNote">{say("预览使用预先写好的台词。", "The preview plays pre-written lines.")}</p>
          {/* The bird keeps the builder company beside the preview: a different mood for each step. */}
          <Mascot
            className="buildBird"
            mood={STEP_MOODS[stepId]}
            followCursor
            restOver="a, button, input, select, textarea, label, .siteHeader"
          />
        </aside>
      </div>
    </div>
  );
}
