import { Check, Copy, Pause, Play } from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import type { VoiceVisualizer } from "../../shared/agent";
import { useLanguage } from "../components/LanguageToggle";
import { AssistantPreview, visorPropsFor } from "../components/studio/AssistantPreview";
import { TemplateSwatch } from "../components/TemplatePicker";
import { VisorVisual } from "../components/VisorVisual";
import { VisualizerPreview } from "../components/VisualizerPicker";
import { VoiceEqualizerPanel } from "../components/VoiceEqualizerPanel";
import { SETUP_COMMANDS } from "../lib/assistant-config";
import { BACKENDS, BUILT_IN_EQUALIZER, DEVICES, deviceLogoUrl, findDevice } from "../lib/device-catalog";
import { localized } from "../lib/i18n";
import { APP_PATH, BUILD_PATH, REPOSITORY_URL } from "../lib/routes";
import { useOnScreen, useScrollReveal, useSectionMood, useTyped } from "./motion";
import { VoiceStage } from "./VoiceStage";
import { Mascot, mascotMoodFor } from "../components/Mascot";
import { useScriptedDemo } from "../lib/scripted-demo";
import { TEMPLATES } from "../lib/templates";
import { VISUALIZERS } from "../lib/visualizer";

/** Copies text and says so for a moment. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const { language } = useLanguage();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="siteButton quiet small"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1600);
          },
          () => setCopied(false)
        );
      }}
    >
      {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
      {copied ? localized(language, "已复制", "Copied") : label}
    </button>
  );
}

function Hero({
  signedIn,
  heroRef,
  onScreen
}: {
  signedIn: boolean;
  heroRef: RefObject<HTMLElement | null>;
  onScreen: boolean;
}) {
  const { language } = useLanguage();
  const say = (zh: string, en: string) => localized(language, zh, en);
  const frame = useScriptedDemo("helmet");
  const visor = visorPropsFor(frame);
  return (
    <section className="hero" aria-labelledby="hero-title" ref={heroRef}>
      <div className="heroText">
        <h1 id="hero-title">{say("给你的产品加上会说话的智能体。", "A voice agent for your product.")}</h1>
        <p>
          {say(
            "开源的实时语音智能体，放进网站、应用或穿戴设备。支持任意语音模型。",
            "An open-source realtime voice agent for your site, app or wearable. Use any voice model."
          )}
        </p>
        <div className="heroActions">
          {signedIn ? (
            <a className="siteButton" href={APP_PATH}>
              {say("打开应用", "Open the app")}
            </a>
          ) : (
            <a className="siteButton" href="#demo">
              {say("试试演示", "Try the demo")}
            </a>
          )}
          <a className="siteButton secondary" href={BUILD_PATH}>
            {say("配置你自己的", "Build yours")}
          </a>
          {signedIn ? (
            <a className="siteTextLink" href="#demo">
              {say("看演示", "Watch the demo")}
            </a>
          ) : null}
        </div>
      </div>
      <div className="heroLens" aria-hidden="true">
        <VisorVisual {...visor} visualizer="wave" />
        <Mascot
          className="heroBird"
          mood={mascotMoodFor(visor)}
          followCursor={onScreen}
          restOver=".heroActions, .siteHeader"
        />
      </div>
    </section>
  );
}

function SectionHead({ id, title, lede }: { id: string; title: string; lede: string }) {
  return (
    <header className="sectionHead" data-reveal="">
      <h2 id={id}>{title}</h2>
      <p>{lede}</p>
    </header>
  );
}

function Demo() {
  const { language } = useLanguage();
  const say = (zh: string, en: string) => localized(language, zh, en);
  const en = language === "en-US";
  const id = useId();
  const [device, setDevice] = useState("motorcycle-helmet");
  const [template, setTemplate] = useState<string | null>(null);
  const [visualizer, setVisualizer] = useState<VoiceVisualizer | null>(null);
  const [playing, setPlaying] = useState(true);
  const preset = findDevice(device);
  const activeTemplate = template ?? preset.template;
  const activeVisualizer = visualizer ?? preset.visualizer;
  return (
    <section className="siteSection demoSection" aria-labelledby="demo">
      <SectionHead
        id="demo"
        title={say("试试演示", "Try the demo")}
        lede={say("这是一段脚本预览，不用账号，也不用麦克风。", "A scripted preview. No account or microphone needed.")}
      />
      <div className="demoLayout" data-reveal="">
        <AssistantPreview
          identity={{ name: "Max", device, template: activeTemplate, visualizer: activeVisualizer }}
          playing={playing}
          label={say("脚本演示", "Scripted demo")}
        />
        <div className="demoControls">
          <div className="demoControl">
            <label htmlFor={`${id}-device`}>{say("设备", "Device")}</label>
            <select
              id={`${id}-device`}
              className="studioSelect"
              value={device}
              onChange={(event) => {
                setDevice(event.currentTarget.value);
                setTemplate(null);
                setVisualizer(null);
              }}
            >
              {DEVICES.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {en ? entry.label.en : entry.label.zh}
                </option>
              ))}
            </select>
          </div>
          <fieldset className="demoControl">
            <legend>{say("设计模板", "Design template")}</legend>
            <div className="demoSwatches">
              {TEMPLATES.map((entry) => (
                <button
                  type="button"
                  key={entry.id}
                  className={entry.id === activeTemplate ? "active" : ""}
                  aria-pressed={entry.id === activeTemplate}
                  onClick={() => setTemplate(entry.id)}
                >
                  <TemplateSwatch template={entry} />
                  <span>{en ? entry.label.en : entry.label.zh}</span>
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset className="demoControl">
            <legend>{say("语音显示", "Voice display")}</legend>
            <div className="demoSwatches">
              {VISUALIZERS.map((entry) => (
                <button
                  type="button"
                  key={entry.id}
                  className={entry.id === activeVisualizer ? "active" : ""}
                  aria-pressed={entry.id === activeVisualizer}
                  onClick={() => setVisualizer(entry.id)}
                >
                  <VisualizerPreview style={entry.id} />
                  <span>{en ? entry.label.en : entry.label.zh}</span>
                </button>
              ))}
            </div>
          </fieldset>
          <button type="button" className="siteButton quiet small" onClick={() => setPlaying((value) => !value)}>
            {playing ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
            {playing ? say("暂停演示", "Pause the demo") : say("继续演示", "Play the demo")}
          </button>
        </div>
      </div>
    </section>
  );
}

function Devices() {
  const { language } = useLanguage();
  const say = (zh: string, en: string) => localized(language, zh, en);
  const en = language === "en-US";
  return (
    <section className="siteSection" aria-labelledby="devices">
      <SectionHead
        id="devices"
        title={say("先选设备，助手随之改变", "Pick the device. The assistant changes with it.")}
        lede={say("每种设备都有自己的行为、外观和声音。", "Each one brings its own behavior, look and sound.")}
      />
      <ul className="deviceList revealStagger" data-reveal="">
        {DEVICES.map((device) => {
          const logo = deviceLogoUrl(device.id);
          return (
            <li key={device.id}>
              {logo ? <img src={logo} alt="" width={56} height={56} loading="lazy" /> : null}
              <h3 title={en ? device.note.en : device.note.zh}>{en ? device.label.en : device.label.zh}</h3>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Backends() {
  const { language } = useLanguage();
  const say = (zh: string, en: string) => localized(language, zh, en);
  const en = language === "en-US";
  const groups = [
    {
      place: "cloud" as const,
      title: say("云端模型，需要 API 密钥", "In the cloud, with an API key"),
      note: say("密钥只留在你的服务器上。", "Keys stay on your server.")
    },
    {
      place: "local" as const,
      title: say("你自己的硬件，无需密钥", "On your own hardware, no key"),
      note: say("可以完全离线运行。", "Can run fully offline.")
    }
  ];
  return (
    <section className="siteSection" aria-labelledby="backends">
      <SectionHead
        id="backends"
        title={say("用你想要的模型说话", "Speak through the model you choose")}
        lede={say(
          "换模型不换体验：唤醒词、工具、安全提醒和记忆都一样。",
          "Switch models and keep the wake word, tools, safety alerts and memory."
        )}
      />
      <div className="backendGroups revealStagger" data-reveal="">
        {groups.map((group) => (
          <div key={group.place} className="backendGroup">
            <h3>{group.title}</h3>
            <p className="backendGroupNote">{group.note}</p>
            <ul>
              {BACKENDS.filter((backend) => backend.place === group.place).map((backend) => (
                <li key={backend.id}>
                  <strong title={en ? backend.description.en : backend.description.zh}>{backend.label}</strong>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <p className="backendDemoNote" data-reveal="">
        {say("还没有密钥？先用演示后端。", "No key yet? Start with the demo backend.")}
      </p>
    </section>
  );
}

function LookAndSound() {
  const { language } = useLanguage();
  const say = (zh: string, en: string) => localized(language, zh, en);
  const en = language === "en-US";
  return (
    <section className="siteSection" aria-labelledby="look">
      <SectionHead
        id="look"
        title={say("外观和声音都是你的", "Make it look and sound like yours")}
        lede={say("模板、语音显示和均衡器，都可以换。", "Change the template, the voice display and the equaliser.")}
      />
      <div className="lookGrid revealStagger" data-reveal="">
        <div>
          <h3>{say("五个设计模板", "Five design templates")}</h3>
          <ul className="lookList">
            {TEMPLATES.map((template) => (
              <li key={template.id}>
                <TemplateSwatch template={template} />
                <span>
                  <strong>{en ? template.label.en : template.label.zh}</strong>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3>{say("五种语音显示", "Five voice displays")}</h3>
          <ul className="lookList">
            {VISUALIZERS.map((entry) => (
              <li key={entry.id}>
                <VisualizerPreview style={entry.id} />
                <span>
                  <strong>{en ? entry.label.en : entry.label.zh}</strong>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div className="lookEq">
          <h3>{say("十段均衡器", "A ten-band equaliser")}</h3>
          <p>{say("十五个预设，也可以自己调。", "Fifteen presets, or set each band yourself.")}</p>
          <VoiceEqualizerPanel
            options={{ ...BUILT_IN_EQUALIZER, adjustable: false, default: { preset: "wind" } }}
            value={null}
            onChange={() => {}}
            enabled
            onEnabledChange={() => {}}
          />
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  const { language } = useLanguage();
  const say = (zh: string, en: string) => localized(language, zh, en);
  const steps = [
    {
      title: say("运行中继", "Run the relay"),
      text: say("你自己部署的服务，保管密钥和记忆。", "A server you host. It holds your keys and memory.")
    },
    {
      title: say("描述你的助手", "Describe your assistant"),
      text: say("用配置器或工作室设置名字、声音和外观。", "Set its name, voice and look in the configurator or Studio.")
    },
    {
      title: say("打开应用", "Open the apps"),
      text: say("网页、iOS 和 Android 连接同一个中继。", "Web, iOS and Android share one relay.")
    },
    {
      title: say("戴上它", "Put it on the device"),
      text: say("通过手机和耳机，或直接在设备上运行。", "Use a phone and headset, or run it on the device.")
    }
  ];
  return (
    <section className="siteSection" aria-labelledby="how">
      <SectionHead
        id="how"
        title={say("它是怎么组成的", "How it fits together")}
        lede={say("免费自行部署，或交给 Max Cloud。", "Self-host for free, or let Max Cloud run it.")}
      />
      <ol className="howSteps revealStagger" data-reveal="">
        {steps.map((step) => (
          <li key={step.title}>
            <h3>{step.title}</h3>
            <p>{step.text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function GetStarted() {
  const { language } = useLanguage();
  const say = (zh: string, en: string) => localized(language, zh, en);
  const commands = SETUP_COMMANDS.join("\n");
  const layout = useRef<HTMLDivElement | null>(null);
  const [arrived, setArrived] = useState(false);
  const seen = useOnScreen(layout, "0px 0px -15% 0px", false);
  useEffect(() => {
    // Starts once: scrolling away and back does not type it again.
    if (seen) setArrived(true);
  }, [seen]);
  const typed = useTyped(commands, arrived);
  return (
    <section className="siteSection startSection" aria-labelledby="start">
      <SectionHead
        id="start"
        title={say("开始", "Get started")}
        lede={say("安装依赖，回答几个设置问题，然后启动。", "Install, answer a few setup questions, and start it.")}
      />
      <div className="startLayout" data-reveal="" ref={layout}>
        <div className="codeBlock">
          <pre>
            {/* The full text sets the block's size; the typed copy sits over it. */}
            <code className="codeGhost" aria-hidden="true">
              {commands}
            </code>
            <code className="codeTyped">
              {commands.slice(0, typed)}
              {typed < commands.length ? <i className="codeCaret" aria-hidden="true" /> : null}
            </code>
          </pre>
          <CopyButton text={commands} label={say("复制命令", "Copy commands")} />
        </div>
        <ul className="startNotes">
          <li>
            <code>npm run brand</code> {say("用你的标志生成应用图标。", "writes the app icons from your logo.")}
          </li>
          <li>
            <code>docs/local-models.md</code> {say("介绍如何完全离线运行。", "explains running fully offline.")}
          </li>
          <li>
            <code>start-speech.command</code>{" "}
            {say("在 Apple 芯片的 Mac 上启动 Max Speech。", "starts Max Speech on an Apple silicon Mac.")}
          </li>
        </ul>
      </div>
      <div className="startActions" data-reveal="">
        <a className="siteButton" href={BUILD_PATH}>
          {say("配置你自己的", "Build yours")}
        </a>
        <a className="siteButton secondary" href={APP_PATH}>
          {say("打开应用", "Open the app")}
        </a>
        {REPOSITORY_URL ? (
          <a className="siteTextLink" href={REPOSITORY_URL} rel="noreferrer noopener">
            GitHub
          </a>
        ) : null}
      </div>
    </section>
  );
}

export function LandingPage({ signedIn }: { signedIn: boolean }) {
  useScrollReveal();
  const hero = useRef<HTMLElement | null>(null);
  const heroOnScreen = useOnScreen(hero);
  const mood = useSectionMood();
  return (
    <>
      <Hero signedIn={signedIn} heroRef={hero} onScreen={heroOnScreen} />
      {/* Past the hero, the bird comes along: it keeps to a corner, follows
          the cursor, and changes with the part of the page in view. */}
      {heroOnScreen ? null : (
        <Mascot className="siteBird" mood={mood} followCursor restOver="a, button, input, select, .siteHeader" />
      )}
      <Demo />
      <Devices />
      <Backends />
      <VoiceStage />
      <LookAndSound />
      <HowItWorks />
      <GetStarted />
    </>
  );
}
