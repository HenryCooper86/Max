import { Check, Copy, Pause, Play } from "@phosphor-icons/react";
import { useId, useState } from "react";
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

function Hero({ signedIn }: { signedIn: boolean }) {
  const { language } = useLanguage();
  const say = (zh: string, en: string) => localized(language, zh, en);
  const frame = useScriptedDemo("helmet");
  const visor = visorPropsFor(frame);
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="heroText">
        <h1 id="hero-title">
          {say("给人们戴着的东西，做一个自己的语音助手。", "Your own voice assistant, for the things people wear.")}
        </h1>
        <p>
          {say(
            "Max 是一个开放框架，用来做头盔、眼镜和头显里的免手语音助手。设备、名字、外观、声音和模型都由你决定，跑在你自己的服务器上。",
            "Max is an open framework for hands-free assistants in helmets, glasses and headsets. You choose the device, the name, the look, the voice and the model, and you run it yourself."
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
        <Mascot className="heroBird" mood={mascotMoodFor(visor)} followCursor restOver=".heroActions, .siteHeader" />
      </div>
    </section>
  );
}

function SectionHead({ id, title, lede }: { id: string; title: string; lede: string }) {
  return (
    <header className="sectionHead">
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
        lede={say(
          "这是一段脚本预览：不连接服务器，不用账号，也不用麦克风。台词都是预先写好的，用来展示一次会话在不同设备上的样子。",
          "This is a scripted preview. Nothing connects to a server and no account or microphone is used: the lines are written in advance, to show what a session looks like on different devices."
        )}
      />
      <div className="demoLayout">
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
        lede={say(
          "每种设备带着自己的行为准则、标志、默认外观和声音。任何一项都可以再改。",
          "Each device brings its own conduct for the assistant, its own mark, and a default look and sound. You can change any of them."
        )}
      />
      <ul className="deviceList">
        {DEVICES.map((device) => {
          const logo = deviceLogoUrl(device.id);
          const template = TEMPLATES.find((entry) => entry.id === device.template);
          const viz = VISUALIZERS.find((entry) => entry.id === device.visualizer);
          const sound = BUILT_IN_EQUALIZER.presets.find((entry) => entry.id === device.equalizer)?.label;
          return (
            <li key={device.id}>
              {logo ? <img src={logo} alt="" width={56} height={56} loading="lazy" /> : null}
              <div>
                <h3>{en ? device.label.en : device.label.zh}</h3>
                <p>{en ? device.note.en : device.note.zh}</p>
                <p className="deviceDefaults">
                  {say("默认：", "Defaults: ")}
                  {template ? (en ? template.label.en : template.label.zh) : device.template}
                  {say("模板，", " template, ")}
                  {viz ? (en ? viz.label.en.toLowerCase() : viz.label.zh) : device.visualizer}
                  {say("显示，均衡器", " display, ")}
                  {sound ?? device.equalizer}
                  {say("。", " equaliser.")}
                </p>
              </div>
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
      note: say(
        "密钥写在服务器的 .env 里，从不发到应用。",
        "Keys stay in the relay's .env file and never reach the apps."
      )
    },
    {
      place: "local" as const,
      title: say("你自己的硬件，无需密钥", "On your own hardware, no key"),
      note: say(
        "开放权重模型可完全离线运行，见 docs/local-models.md。",
        "Open-weight models can run fully offline. docs/local-models.md shows how."
      )
    }
  ];
  return (
    <section className="siteSection" aria-labelledby="backends">
      <SectionHead
        id="backends"
        title={say("用你想要的模型说话", "Speak through the model you choose")}
        lede={say(
          "同一个会话核心服务所有后端：唤醒词、免手设备操作（导航、相机、手电筒、音乐、通话）、安全提醒和记忆都一样。",
          "One session core serves every backend, so the wake word, hands-free device actions (navigation, camera, torch, music, calls), safety alerts and memory work the same on all of them."
        )}
      />
      <div className="backendGroups">
        {groups.map((group) => (
          <div key={group.place} className="backendGroup">
            <h3>{group.title}</h3>
            <p className="backendGroupNote">{group.note}</p>
            <ul>
              {BACKENDS.filter((backend) => backend.place === group.place).map((backend) => (
                <li key={backend.id}>
                  <strong>{backend.label}</strong>
                  <span>{en ? backend.description.en : backend.description.zh}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <p className="backendDemoNote">
        {say(
          "还有一个不需要任何密钥的演示后端，用来先把设备和应用跑通。",
          "There is also a demo backend that needs no key at all, for getting the device and apps working first."
        )}
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
        lede={say(
          "设计模板改变整个应用，语音显示改变镜片里的声音，均衡器改变它的声音本身。",
          "Design templates change the whole app, the voice display changes how speech looks in the lens, and the equaliser changes how it sounds."
        )}
      />
      <div className="lookGrid">
        <div>
          <h3>{say("五个设计模板", "Five design templates")}</h3>
          <ul className="lookList">
            {TEMPLATES.map((template) => (
              <li key={template.id}>
                <TemplateSwatch template={template} />
                <span>
                  <strong>{en ? template.label.en : template.label.zh}</strong>
                  <small>{en ? template.description.en : template.description.zh}</small>
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
          <p>
            {say(
              "十五个预设，从头盔风噪到电话音色，也可以自己拉每一段。",
              "Fifteen presets, from helmet wind to telephone, or set each band yourself."
            )}
          </p>
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
      text: say(
        "一个你自己部署的 Node 服务。它保管密钥、连接语音后端，并为每位使用者保存记忆。",
        "A Node server you host. It holds your keys, talks to the voice backend and keeps each wearer's memory."
      )
    },
    {
      title: say("描述你的助手", "Describe your assistant"),
      text: say(
        "写进 assistant.config.json：用 npm run setup 生成，用这里的配置器，或在应用里的工作室修改。",
        "It lives in assistant.config.json: written by npm run setup, by the configurator here, or from the Studio inside the app."
      )
    },
    {
      title: say("打开应用", "Open the apps"),
      text: say(
        "网页应用、iOS 和 Android 应用连接同一个中继。",
        "The web app and the iOS and Android apps all connect to the same relay."
      )
    },
    {
      title: say("戴上它", "Put it on the device"),
      text: say(
        "在手机上用设备的耳机说话，或在设备的板子上运行嵌入式客户端。",
        "Talk through the device's headset with a phone app, or run the embedded board client on the device itself."
      )
    }
  ];
  return (
    <section className="siteSection" aria-labelledby="how">
      <SectionHead
        id="how"
        title={say("它是怎么组成的", "How it fits together")}
        lede={say("全部自行部署，没有托管服务。", "Everything is self-hosted. There is no hosted service.")}
      />
      <ol className="howSteps">
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
  return (
    <section className="siteSection startSection" aria-labelledby="start">
      <SectionHead
        id="start"
        title={say("开始", "Get started")}
        lede={say("安装依赖，回答几个设置问题，然后启动。", "Install, answer a few setup questions, and start it.")}
      />
      <div className="startLayout">
        <div className="codeBlock">
          <pre>
            <code>{commands}</code>
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
        </ul>
      </div>
      <div className="startActions">
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
  return (
    <>
      <Hero signedIn={signedIn} />
      <Demo />
      <Devices />
      <Backends />
      <LookAndSound />
      <HowItWorks />
      <GetStarted />
    </>
  );
}
