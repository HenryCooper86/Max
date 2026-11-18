import { useState } from "react";
import { CLOUD_LANGUAGES, CLOUD_VOICES } from "../../../shared/cloud-studio";
import { useLanguage } from "../../components/LanguageToggle";
import type { Language } from "../../lib/i18n";
import type { Backend } from "../api";
import { useSay } from "../hooks";
import type { StudioTabProps } from "./types";

export const BACKENDS: {
  id: Backend;
  label: string;
  provider: string;
  keyUrl: string;
  keyHint: { zh: string; en: string };
}[] = [
  {
    id: "openai",
    label: "OpenAI Realtime",
    provider: "OpenAI",
    keyUrl: "https://platform.openai.com/api-keys",
    keyHint: { zh: "以 sk- 开头", en: "Starts with sk-" }
  },
  {
    id: "gemini",
    label: "Gemini Live",
    provider: "Google AI Studio",
    keyUrl: "https://aistudio.google.com/apikey",
    keyHint: { zh: "在 Google AI Studio 创建", en: "Made in Google AI Studio" }
  },
  {
    id: "grok",
    label: "Grok Voice (xAI)",
    provider: "xAI",
    keyUrl: "https://console.x.ai",
    keyHint: { zh: "以 xai- 开头", en: "Starts with xai-" }
  }
];

type Tone = "friendly" | "professional" | "playful" | "calm";

type InstructionBrief = {
  business: string;
  job: string;
  tone: Tone;
  never: string;
};

const TONES: Record<Tone, { label: { zh: string; en: string }; en: string; zh: string }> = {
  friendly: { label: { zh: "友好", en: "Friendly" }, en: "warm and friendly", zh: "温暖友好" },
  professional: { label: { zh: "专业", en: "Professional" }, en: "clear and professional", zh: "清晰专业" },
  playful: { label: { zh: "活泼", en: "Playful" }, en: "upbeat and a little playful", zh: "轻松活泼" },
  calm: { label: { zh: "沉稳", en: "Calm" }, en: "calm and reassuring", zh: "沉稳令人安心" }
};

/** Turns a few plain answers into instructions a voice model follows well. */
export function writeInstructions(brief: InstructionBrief, language: Language): string {
  const business = brief.business.trim();
  const job = brief.job.trim();
  const never = brief.never.trim();
  const tone = TONES[brief.tone];
  if (language !== "en-US") {
    return [
      business ? `你是${business}的语音助手。` : "你是一名语音助手。",
      job ? `你的工作：${job}` : "",
      `语气${tone.zh}。用简短自然的句子说话，这是语音对话：不要用列表或 Markdown，一次只问一个问题。`,
      "根据参考信息回答；不知道就直说，并告诉对方你能做什么。绝不编造价格、政策或库存。",
      never ? `绝不要：${never}` : ""
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    business ? `You are the voice assistant for ${business}.` : "You are a voice assistant.",
    job ? `Your job: ${job}` : "",
    `Be ${tone.en}. Speak in short, natural sentences: this is a voice conversation, so no lists or markdown, and ask one question at a time.`,
    "Answer from the reference information. If you don't know, say so and offer what you can do instead. Never make up prices, policies or availability.",
    never ? `Never: ${never}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function InstructionWriter({ onWrite }: { onWrite: (text: string, mode: "replace" | "append") => void }) {
  const say = useSay();
  const { language } = useLanguage();
  const [brief, setBrief] = useState<InstructionBrief>({ business: "", job: "", tone: "friendly", never: "" });
  const set = (patch: Partial<InstructionBrief>) => setBrief((current) => ({ ...current, ...patch }));
  const text = writeInstructions(brief, language);
  return (
    <details className="cxsWriter">
      <summary>{say("帮我写：回答几个问题", "Help me write it: answer a few questions")}</summary>
      <div className="cxsWriterBody">
        <label className="cxField">
          <span>{say("你的企业或产品叫什么、做什么？", "What is your business or product?")}</span>
          <input
            value={brief.business}
            maxLength={200}
            placeholder={say(
              "例如：街角面包店，手工面包和定制蛋糕",
              "e.g. Corner Bakery, fresh bread and custom cakes"
            )}
            onChange={(event) => set({ business: event.target.value })}
          />
        </label>
        <label className="cxField">
          <span>{say("它要帮用户做什么？", "What should it help people with?")}</span>
          <textarea
            rows={2}
            value={brief.job}
            maxLength={600}
            placeholder={say(
              "例如：回答营业时间和价格问题，帮客户预订蛋糕",
              "e.g. answer questions about hours and prices, and help customers order cakes"
            )}
            onChange={(event) => set({ job: event.target.value })}
          />
        </label>
        <fieldset className="cxsChoices">
          <legend>{say("语气", "Tone")}</legend>
          {(Object.keys(TONES) as Tone[]).map((tone) => (
            <label key={tone} className={brief.tone === tone ? "active" : undefined}>
              <input
                type="radio"
                name="cxs-tone"
                value={tone}
                checked={brief.tone === tone}
                onChange={() => set({ tone })}
              />
              {say(TONES[tone].label.zh, TONES[tone].label.en)}
            </label>
          ))}
        </fieldset>
        <label className="cxField">
          <span>{say("有什么绝不能做的？（可选）", "Anything it must never do? (optional)")}</span>
          <input
            value={brief.never}
            maxLength={300}
            placeholder={say("例如：承诺折扣、提供医疗建议", "e.g. promise discounts, give medical advice")}
            onChange={(event) => set({ never: event.target.value })}
          />
        </label>
        <pre className="cxCode cxsPreview" aria-label={say("预览", "Preview")}>
          {text}
        </pre>
        <div className="cxRow">
          <button type="button" className="siteButton small" onClick={() => onWrite(text, "replace")}>
            {say("用它替换指令", "Use as instructions")}
          </button>
          <button type="button" className="siteButton secondary small" onClick={() => onWrite(text, "append")}>
            {say("加到指令末尾", "Add to the end")}
          </button>
        </div>
      </div>
    </details>
  );
}

/** Studio → Agent: who the agent is, how it sounds and what it is told. */
export function AgentTab({ session, project, draft, update, updateStudio, onProjectChanged }: StudioTabProps) {
  const say = useSay();
  const [keyStatus, setKeyStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const backend = BACKENDS.find((option) => option.id === draft.backend) ?? BACKENDS[0]!;
  const voices = CLOUD_VOICES[draft.backend];
  const field = (suffix: string) => `cxs-${project.id}-${suffix}`;

  const removeKey = async () => {
    setBusy(true);
    try {
      const result = await session.api.updateProject(session.token, project.id, { modelKey: "" });
      onProjectChanged(result.project);
      update({ modelKey: "" });
      setKeyStatus(say("模型密钥已移除。", "Model key removed."));
    } catch (error) {
      setKeyStatus(session.fail(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cxsPanel">
      <div className="cxsGrid">
        <label className="cxField" htmlFor={field("assistant")}>
          <span>{say("助手名称", "Agent name")}</span>
          <input
            id={field("assistant")}
            maxLength={24}
            value={draft.assistantName}
            placeholder="Ava"
            onChange={(event) => update({ assistantName: event.target.value })}
          />
          <small>{say("它会这样介绍自己。", "What it calls itself.")}</small>
        </label>
        <label className="cxField" htmlFor={field("language")}>
          <span>{say("语言", "Language")}</span>
          <select
            id={field("language")}
            value={draft.studio.language}
            onChange={(event) => updateStudio({ language: event.target.value })}
          >
            {CLOUD_LANGUAGES.map((option) => (
              <option key={option.code} value={option.code}>
                {say(option.label.zh, option.label.en)}
              </option>
            ))}
          </select>
          <small>
            {say(
              "它先说这种语言；用户换语言时会跟着换。",
              "It starts in this language and follows the user if they switch."
            )}
          </small>
        </label>
      </div>

      <div className="cxsGrid">
        <label className="cxField" htmlFor={field("backend")}>
          <span>{say("语音模型", "Voice model")}</span>
          <select
            id={field("backend")}
            value={draft.backend}
            onChange={(event) => update({ backend: event.target.value as Backend })}
          >
            {BACKENDS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          <small>{say("用你自己的模型账户付模型费用。", "You pay the model provider with your own account.")}</small>
        </label>
        <div className="cxField">
          <label htmlFor={field("key")}>
            <span>{say("模型密钥", "Model key")}</span>
          </label>
          <div className="cxRow">
            <input
              id={field("key")}
              type="password"
              autoComplete="off"
              maxLength={400}
              placeholder={
                project.hasModelKey ? say("•••• 已保存", "•••• saved") : say(backend.keyHint.zh, backend.keyHint.en)
              }
              aria-describedby={field("key-hint")}
              value={draft.modelKey}
              onChange={(event) => update({ modelKey: event.target.value })}
            />
            {project.hasModelKey ? (
              <button
                type="button"
                className="siteButton secondary small"
                disabled={busy}
                onClick={() => void removeKey()}
              >
                {say("移除", "Remove")}
              </button>
            ) : null}
          </div>
          <small id={field("key-hint")}>
            {project.hasModelKey
              ? say(
                  "留空表示不改。保存后加密存放，不会再显示。",
                  "Leave empty to keep it. It is stored encrypted and never shown again."
                )
              : say("还没有？", "Don't have one? ")}
            {project.hasModelKey ? null : (
              <a className="siteTextLink" href={backend.keyUrl} target="_blank" rel="noreferrer noopener">
                {say(`在${backend.provider}创建密钥`, `Get a key from ${backend.provider}`)}
              </a>
            )}
          </small>
          <span className="cxStatus" aria-live="polite">
            {keyStatus}
          </span>
        </div>
      </div>

      <fieldset className="cxsVoices">
        <legend>{say("声音", "Voice")}</legend>
        <label className={draft.studio.voice === "" ? "active" : undefined}>
          <input
            type="radio"
            name={field("voice")}
            checked={draft.studio.voice === ""}
            onChange={() => updateStudio({ voice: "" })}
          />
          <strong>{say("默认", "Default")}</strong>
          <span>{say(`${voices[0]?.label ?? ""}，推荐`, `${voices[0]?.label ?? ""}, recommended`)}</span>
        </label>
        {voices.map((voice) => (
          <label key={voice.id} className={draft.studio.voice === voice.id ? "active" : undefined}>
            <input
              type="radio"
              name={field("voice")}
              checked={draft.studio.voice === voice.id}
              onChange={() => updateStudio({ voice: voice.id })}
            />
            <strong>{voice.label}</strong>
            <span>{say(voice.note.zh, voice.note.en)}</span>
          </label>
        ))}
      </fieldset>

      <div className="cxField">
        <label htmlFor={field("instructions")}>
          <span>{say("指令", "Instructions")}</span>
        </label>
        <small>
          {say(
            "告诉它是谁、帮谁做什么、怎么说话。像给新同事交代工作一样写。",
            "Tell it who it is, who it helps, with what, and how to talk. Write it like a brief for a new colleague."
          )}
        </small>
        <textarea
          id={field("instructions")}
          rows={9}
          maxLength={8000}
          value={draft.instructions}
          onChange={(event) => update({ instructions: event.target.value })}
        />
        <small className="cxsCount">{draft.instructions.length.toLocaleString()} / 8,000</small>
      </div>
      <InstructionWriter
        onWrite={(text, mode) =>
          update({
            instructions: (mode === "append" && draft.instructions.trim()
              ? `${draft.instructions.trim()}\n\n${text}`
              : text
            ).slice(0, 8000)
          })
        }
      />

      <label className="cxField" htmlFor={field("greeting")}>
        <span>{say("开场白", "Greeting")}</span>
        <input
          id={field("greeting")}
          maxLength={300}
          value={draft.greeting}
          placeholder={say("你好！有什么可以帮你？", "Hi! How can I help?")}
          onChange={(event) => update({ greeting: event.target.value })}
        />
        <small>
          {say(
            "它开口说的第一句话。留空则等用户先说。",
            "The first thing it says. Leave empty to let the user speak first."
          )}
        </small>
      </label>
    </div>
  );
}
