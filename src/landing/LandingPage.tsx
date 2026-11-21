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
            "Max 是开源的实时语音智能体工具包。用一个 script 标签放进网站或应用，或者装进头盔、眼镜和头显；接入你自己的工具，选择任意语音模型，自己部署或交给 Max Cloud。",
            "Max is an open-source kit for realtime voice agents. Add one to a website or app with a single script tag, or put it in a helmet, glasses or a headset. Give it your own tools, pick any voice model, and run it yourself or let Max Cloud host it."
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
        lede={say(
          "这是一段脚本预览：不连接服务器，不用账号，也不用麦克风。台词都是预先写好的，用来展示一次会话在不同设备上的样子。",
          "This is a scripted preview. Nothing connects to a server and no account or microphone is used: the lines are written in advance, to show what a session looks like on different devices."
        )}
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
        lede={say(
          "每种设备带着自己的行为准则、标志、默认外观和声音。任何一项都可以再改。",
          "Each device brings its own conduct for the assistant, its own mark, and a default look and sound. You can change any of them."
        )}
      />
      <ul className="deviceList revealStagger" data-reveal="">
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
      <div className="backendGroups revealStagger" data-reveal="">
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
      <p className="backendDemoNote" data-reveal="">
        {say(
          "还有一个不需要任何密钥的演示后端，用来先把设备和应用跑通。",
          "There is also a demo backend that needs no key at all, for getting the device and apps working first."
        )}
      </p>
    </section>
  );
}

function LocalSpeech() {
  const { language } = useLanguage();
  const say = (zh: string, en: string) => localized(language, zh, en);
  const features = [
    {
      title: say("实时对话", "Live conversation"),
      text: say(
        "你说话时文字就开始出现（中文和英文），由学习得到的轮次检测判断你是否说完。",
        "Your words appear while you speak, in Chinese and English, and a learned turn detector decides when you have finished."
      )
    },
    {
      title: say("八种语言的语音", "Speech in eight languages"),
      text: say(
        "中文、英语、西班牙语、法语、印地语、意大利语、日语和葡萄牙语。中文由专门的模型朗读。",
        "English, Chinese, Spanish, French, Hindi, Italian, Japanese and Portuguese, with a dedicated model for Chinese."
      )
    },
    {
      title: say("经同意的声音克隆", "Voice cloning, with consent"),
      text: say(
        "用 5 到 30 秒的录音克隆声音，必须提供说话人的同意声明，并与声音一起保存。支持 Apple 芯片和 CPU，暂不支持 NVIDIA。",
        "Clone a voice from 5 to 30 seconds of speech. The speaker's consent statement is required and kept with the voice. Works on Apple silicon or a CPU, not yet on NVIDIA."
      )
    },
    {
      title: say("用文字设计声音", "Voice design"),
      text: say(
        "描述你想要的声音，试听候选后保存。需要 24 GB 或以上内存的 Apple 芯片电脑。",
        "Describe the voice you want, listen to the candidates and keep one. Needs Apple silicon with 24 GB of memory or more."
      )
    },
    {
      title: say("工作室里的声音管理", "Voices in the Studio"),
      text: say(
        "在管理工作室里试听、克隆、设计和选择声音，并修改发音。",
        "Hear, clone, design and choose voices, and correct pronunciations, from the admin Studio."
      )
    },
    {
      title: say("Mac 或 Docker", "On a Mac or in Docker"),
      text: say(
        "在 Mac 上双击 start-speech.command，或运行 CPU、NVIDIA 的 Docker 镜像。NVIDIA 镜像尚未在 GPU 上测试。",
        "Double-click start-speech.command on a Mac, or run the CPU or NVIDIA Docker image. The NVIDIA image has not been tested on a GPU yet."
      )
    }
  ];
  return (
    <section className="siteSection" aria-labelledby="speech">
      <SectionHead
        id="speech"
        title={say("Max Speech：声音留在你自己的机器上", "Max Speech: a voice that stays on your machine")}
        lede={say(
          "Max 自带的开源语音服务。它在你自己的硬件上听和说，音频不出你的机器，也没有按分钟计算的模型费用。",
          "The open-source speech server that comes with Max. It listens and speaks on your own hardware, so audio stays with you and there is no per-minute model bill."
        )}
      />
      <ul className="speechFeatures revealStagger" data-reveal="">
        {features.map((feature) => (
          <li key={feature.title}>
            <h3>{feature.title}</h3>
            <p>{feature.text}</p>
          </li>
        ))}
      </ul>
      <p className="backendDemoNote" data-reveal="">
        {say(
          "每个模型都要通过商用许可白名单，并固定在指定版本。Max Speech 用于自行部署，不包含在 Max Cloud 中。",
          "Every model must pass a commercial-use license allowlist and is pinned to a fixed version. Max Speech is for self-hosting and is not part of Max Cloud."
        )}{" "}
        <a
          className="siteTextLink"
          href={`${REPOSITORY_URL}/blob/main/docs/speech-server-deployment.md`}
          rel="noreferrer noopener"
        >
          {say("部署指南", "Deployment guide")}
        </a>
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
      <div className="lookGrid revealStagger" data-reveal="">
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
        lede={say(
          "全部可以免费自行部署；也可以让 Max Cloud 替你运行中继。",
          "Self-host all of it for free, or let Max Cloud run the relay for you."
        )}
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
      <LocalSpeech />
      <LookAndSound />
      <HowItWorks />
      <GetStarted />
    </>
  );
}
