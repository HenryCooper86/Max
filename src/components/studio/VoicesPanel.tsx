import { Microphone, Play, Stop, Trash, UploadSimple, WarningCircle } from "@phosphor-icons/react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { localized, type Language } from "../../lib/i18n";
import {
  voicesApi,
  type DesignCandidate,
  type SpeechVoice,
  type VoiceApiError,
  type VoiceAttribution,
  type VoiceGender,
  type VoiceResult,
  type VoicesApi,
  type VoicesOverview
} from "../../lib/voices-api";
import {
  createWavRecorder,
  downmix,
  RECORDING_MAX_SECONDS,
  wavBlob,
  type RecorderProgress,
  type WavRecorder
} from "../../lib/wav-recorder";
import { useLanguage } from "../LanguageToggle";

const RECORDING_MIN_SECONDS = 5;
const STATEMENT_MIN = 20;
const STATEMENT_MAX = 1000;
const GENDERS: VoiceGender[] = ["female", "male", "neutral"];

/** The microphone and decoder the clone form uses; faked in tests. */
export type VoicesAudio = {
  getStream: () => Promise<MediaStream>;
  createRecorder: (options: {
    onProgress: (progress: RecorderProgress) => void;
    onAutoStop: (recording: { blob: Blob; seconds: number }) => void;
  }) => WavRecorder;
  decodeFile: (file: Blob) => Promise<{ samples: Float32Array; sampleRate: number }>;
};

const browserAudio: VoicesAudio = {
  getStream: () =>
    navigator.mediaDevices.getUserMedia({
      // A cloning reference should be the raw voice: the browser's echo
      // cancellation, noise suppression and gain control all color it.
      audio: {
        channelCount: { ideal: 1 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    }),
  createRecorder: (options) => createWavRecorder(options),
  decodeFile: async (file) => {
    const context = new AudioContext();
    try {
      const decoded = await context.decodeAudioData(await file.arrayBuffer());
      const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index));
      return { samples: downmix(channels), sampleRate: decoded.sampleRate };
    } finally {
      void context.close().catch(() => undefined);
    }
  }
};

type Say = (zh: string, en: string) => string;

type Status = { kind: "ok" | "error"; message: string } | null;

/** Readable text for the speech server's error codes; the server's own message
 *  is the fallback for any code not listed. */
function explain(error: VoiceApiError, say: Say): string {
  switch (error.code) {
    case "consent_required":
      return say(
        "克隆声音需要说话人的同意：勾选确认、填写姓名并保留同意声明。",
        "Cloning needs the speaker's consent: tick the confirmation, give their name and keep the statement."
      );
    case "reference_too_short":
      return say("录音太短，请录 5 到 30 秒。", "That recording is too short. Use 5 to 30 seconds.");
    case "reference_too_long":
      return say("录音太长，请控制在 30 秒以内。", "That recording is too long. Keep it to 30 seconds.");
    case "reference_silent":
      return say(
        "录音里几乎没有声音，请靠近麦克风重录。",
        "The recording is nearly silent. Move closer to the microphone."
      );
    case "reference_clipped":
      return say(
        "录音爆音了，请降低音量或离麦克风远一点重录。",
        "The recording is clipped. Lower the volume or step back and record again."
      );
    case "invalid_audio":
      return say(
        "无法读取这段音频，请换一个文件或重新录制。",
        "That audio can't be read. Try another file or record again."
      );
    case "transcript_required":
      return say(
        "这段录音需要文字稿，请把说的话填在文字稿栏。",
        "This recording needs a transcript. Type what is said in the transcript field."
      );
    case "cloning_unavailable":
      return say("语音服务没有开启克隆功能。", "The speech server has voice cloning turned off.");
    case "design_unavailable":
      return say("语音服务没有开启声音设计功能。", "The speech server has voice design turned off.");
    case "speech_unavailable":
      return say(
        "连不上 Max Speech。请确认它已启动，并且 MAX_SPEECH_URL 设置正确。",
        "Can't reach Max Speech. Check that it is running and that MAX_SPEECH_URL is set."
      );
    case "candidate_not_found":
      return say(
        "这个候选已过期或已保存过，请重新生成。",
        "That candidate expired or was already saved. Generate again."
      );
    case "design_refused":
      return say(
        "声音描述不能要求模仿某个真实的人，请改写描述。",
        "The description can't ask to imitate a specific real person. Describe the voice's qualities instead."
      );
    case "sample_text_too_short":
      return say("试听文字太短，请多写几个字。", "The sample text is too short. Write a little more.");
    case "speech_unauthorized":
      return say(
        "Max Speech 拒绝了中继的密钥（MAX_SPEECH_API_KEY），请检查两边的设置。",
        "Max Speech refused the relay's key (MAX_SPEECH_API_KEY). Check the key on both sides."
      );
    case "voice_not_found":
      return say(
        "找不到这个声音，它可能已被删除。请刷新声音库。",
        "That voice wasn't found. It may have been deleted. Refresh the voice library."
      );
    case "text_too_long":
      return say("文字太长，请缩短。", "That text is too long. Shorten it.");
    case "invalid_lexicon":
      return say("发音表无效，请检查每个词条。", "The pronunciation list isn't valid. Check each entry.");
    case "forbidden_origin":
    case "forbidden_host":
      return say(
        "语音服务拒绝了这个来源。请检查 Max Speech 的允许来源设置。",
        "The speech server refused this origin. Check Max Speech's allowed origins."
      );
    default:
      return error.message;
  }
}

/** Object URLs for audio players, revoked when replaced and on unmount. */
function useBlobUrls() {
  const urls = useRef(new Map<string, string>());
  const alive = useRef(true);
  const [, bump] = useState(0);
  useEffect(() => {
    alive.current = true;
    const held = urls.current;
    return () => {
      alive.current = false;
      for (const url of held.values()) URL.revokeObjectURL(url);
      held.clear();
    };
  }, []);
  return useMemo(
    () => ({
      get: (key: string) => urls.current.get(key),
      set: (key: string, blob: Blob) => {
        if (!alive.current) return;
        const old = urls.current.get(key);
        if (old) URL.revokeObjectURL(old);
        urls.current.set(key, URL.createObjectURL(blob));
        bump((n) => n + 1);
      },
      drop: (key: string) => {
        const old = urls.current.get(key);
        if (old) URL.revokeObjectURL(old);
        urls.current.delete(key);
        bump((n) => n + 1);
      }
    }),
    []
  );
}
type BlobUrls = ReturnType<typeof useBlobUrls>;

type Ctx = {
  api: VoicesApi;
  say: Say;
  language: Language;
  urls: BlobUrls;
  /** Runs a call, reports its failure in the status line, returns data or null. */
  run: <T>(call: Promise<VoiceResult<T>>) => Promise<T | null>;
  notify: (message: string) => void;
  addVoice: (voice: SpeechVoice) => void;
};

function Field({
  label,
  htmlFor,
  hint,
  children
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="studioField">
      {htmlFor ? (
        <label className="studioLabel" htmlFor={htmlFor}>
          {label}
        </label>
      ) : (
        <span className="studioLabel">{label}</span>
      )}
      {children}
      {hint ? <p className="studioHint">{hint}</p> : null}
    </div>
  );
}

function genderLabel(gender: string, say: Say): string {
  if (gender === "female") return say("女声", "Female");
  if (gender === "male") return say("男声", "Male");
  return say("中性", "Neutral");
}

function languageLabel(code: string, say: Say): string {
  if (code === "zh") return say("中文", "Chinese");
  if (code === "en") return say("英语", "English");
  return code;
}

type Props = {
  /** The assistant's chosen voice; "" for the default. */
  voiceId: string;
  onVoiceChange: (id: string) => void;
  /** A custom voice was deleted. The relay already cleared it from the saved
   *  assistant, so the parent drops it from the draft without marking it changed. */
  onVoiceDeleted?: (id: string) => void;
  assistantName: string;
  onAuthenticationExpired: () => void;
  /** Injected in tests. */
  api?: VoicesApi;
  audio?: VoicesAudio;
};

type Load =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "unavailable"; reason: string }
  | { kind: "ready"; overview: Extract<VoicesOverview, { available: true }> };

/**
 * Admin → Studio → Voices: the Max Speech voice library. Everything goes
 * through the relay; choosing the assistant's voice only edits the Studio
 * draft, so the Studio's own Save writes it.
 */
export function VoicesPanel({
  voiceId,
  onVoiceChange,
  onVoiceDeleted,
  assistantName,
  onAuthenticationExpired,
  api = voicesApi,
  audio = browserAudio
}: Props) {
  const { language } = useLanguage();
  const say = useCallback<Say>((zh, en) => localized(language, zh, en), [language]);
  const urls = useBlobUrls();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [status, setStatus] = useState<Status>(null);
  const [lexicon, setLexicon] = useState<Record<string, string> | null>(null);
  const [lexiconError, setLexiconError] = useState<string | null>(null);

  const fail = useCallback(
    (error: VoiceApiError) => {
      if (error.kind === "unauthorized") onAuthenticationExpired();
      return explain(error, say);
    },
    [onAuthenticationExpired, say]
  );

  const run = useCallback(
    async <T,>(call: Promise<VoiceResult<T>>): Promise<T | null> => {
      const result = await call;
      if (result.ok) return result.data;
      setStatus({ kind: "error", message: fail(result.error) });
      return null;
    },
    [fail]
  );

  useEffect(() => {
    let active = true;
    void (async () => {
      const result = await api.listVoices();
      if (!active) return;
      if (!result.ok) {
        setLoad({ kind: "error", message: fail(result.error) });
        return;
      }
      if (!result.data.available) {
        setLoad({ kind: "unavailable", reason: result.data.reason });
        return;
      }
      setLoad({ kind: "ready", overview: result.data });
      const entries = await api.getLexicon();
      if (!active) return;
      if (entries.ok) setLexicon(entries.data);
      else setLexiconError(fail(entries.error));
    })();
    return () => {
      active = false;
    };
    // Load once per mount; error text follows the language only on the next load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  const setVoices = (update: (voices: SpeechVoice[]) => SpeechVoice[]) =>
    setLoad((current) =>
      current.kind === "ready"
        ? { kind: "ready", overview: { ...current.overview, voices: update(current.overview.voices) } }
        : current
    );

  const ctx: Ctx = {
    api,
    say,
    language,
    urls,
    run,
    notify: (message) => setStatus({ kind: "ok", message }),
    addVoice: (voice) => setVoices((voices) => [...voices, voice])
  };

  let body: ReactNode;
  if (load.kind === "loading") {
    body = <p role="status">{say("正在读取声音库…", "Loading the voice library…")}</p>;
  } else if (load.kind === "error") {
    body = (
      <p className="studioError" role="alert">
        <WarningCircle size={16} aria-hidden="true" /> {say("无法读取声音库：", "Couldn't load the voices: ")}
        {load.message}
      </p>
    );
  } else if (load.kind === "unavailable") {
    body = (
      <div className="voicesUnavailable">
        <p>{say("Max Speech 目前不可用。", "Max Speech isn't available right now.")}</p>
        {load.reason ? (
          <p className="studioHint">
            {say("原因：", "Reason: ")}
            {load.reason}
          </p>
        ) : null}
        <p className="studioHint">
          {say(
            "要使用声音库：启动 Max Speech，在中继的环境里设置 MAX_SPEECH_URL（以及 MAX_SPEECH_API_KEY），或在“语音后端”里选择 max-speech。",
            "To use the voice library: start Max Speech and set MAX_SPEECH_URL (and MAX_SPEECH_API_KEY) in the relay's environment, or pick the max-speech backend under Voice backend."
          )}
        </p>
      </div>
    );
  } else {
    const { overview } = load;
    const custom = overview.voices.filter((voice) => voice.kind === "custom");
    const removeVoice = (id: string) => {
      setVoices((voices) => voices.filter((voice) => voice.id !== id));
      if (onVoiceDeleted) onVoiceDeleted(id);
      else if (id === voiceId) onVoiceChange("");
    };
    body = (
      <>
        <VoicePicker ctx={ctx} voices={overview.voices} voiceId={voiceId} onVoiceChange={onVoiceChange} />
        <VoiceList
          ctx={ctx}
          voices={custom}
          onRenamed={(voice) => setVoices((voices) => voices.map((item) => (item.id === voice.id ? voice : item)))}
          onRemoved={removeVoice}
        />
        {overview.cloning ? (
          <CloneForm ctx={ctx} audio={audio} assistantName={assistantName} />
        ) : (
          <p className="studioHint">
            {say("这台语音服务没有开启声音克隆。", "Voice cloning is turned off on this speech server.")}
          </p>
        )}
        {overview.design ? <DesignForm ctx={ctx} /> : null}
        <LexiconEditor ctx={ctx} entries={lexicon} loadError={lexiconError} />
        <Attributions items={overview.attributions} say={say} />
      </>
    );
  }

  return (
    <div className="voicesPanel">
      {body}
      <p role={status?.kind === "error" ? "alert" : "status"} className={`voicesStatus ${status?.kind ?? "idle"}`}>
        {status?.message ?? ""}
      </p>
    </div>
  );
}

// ---- Assistant voice ------------------------------------------------------

function VoicePicker({
  ctx,
  voices,
  voiceId,
  onVoiceChange
}: {
  ctx: Ctx;
  voices: SpeechVoice[];
  voiceId: string;
  onVoiceChange: (id: string) => void;
}) {
  const { say, urls } = ctx;
  const id = useId();
  const [busy, setBusy] = useState(false);
  const presets = voices.filter((voice) => voice.kind === "preset");
  const custom = voices.filter((voice) => voice.kind === "custom");
  const known = !voiceId || voices.some((voice) => voice.id === voiceId);
  const selected = voices.find((voice) => voice.id === voiceId);
  const player = urls.get("pick");
  const play = async () => {
    if (!selected) return;
    setBusy(true);
    const blob = await ctx.run(ctx.api.previewVoice(selected.id));
    setBusy(false);
    if (blob) urls.set("pick", blob);
  };
  return (
    <Field
      label={say("助手的声音", "Assistant voice")}
      htmlFor={`${id}-voice`}
      hint={say(
        "选择后点页面底部的“保存”才会生效。",
        "Choosing a voice changes the draft; use Save at the bottom to apply it."
      )}
    >
      <div className="voicesInline">
        <select
          id={`${id}-voice`}
          className="studioSelect"
          value={voiceId}
          onChange={(event) => {
            urls.drop("pick");
            onVoiceChange(event.currentTarget.value);
          }}
        >
          <option value="">{say("默认", "Default")}</option>
          {presets.length ? (
            <optgroup label={say("内置声音", "Built-in")}>
              {presets.map((voice) => (
                <option key={voice.id} value={voice.id}>
                  {[voice.name, voice.languages.map((code) => languageLabel(code, say)).join(" / ")]
                    .filter(Boolean)
                    .join(" · ")}
                </option>
              ))}
            </optgroup>
          ) : null}
          {custom.length ? (
            <optgroup label={say("自定义声音", "Custom")}>
              {custom.map((voice) => (
                <option key={voice.id} value={voice.id}>
                  {voice.origin === "designed"
                    ? `${voice.name} · ${say("设计", "Designed")}`
                    : voice.origin === "recorded"
                      ? `${voice.name} · ${say("录制", "Recorded")}`
                      : voice.name}
                </option>
              ))}
            </optgroup>
          ) : null}
          {known ? null : <option value={voiceId}>{`${voiceId} ${say("（未找到）", "(not found)")}`}</option>}
        </select>
        <button type="button" className="studioButton" disabled={!selected || busy} onClick={() => void play()}>
          <Play size={14} aria-hidden="true" /> {busy ? say("生成中…", "Generating…") : say("试听", "Play")}
        </button>
      </div>
      {player ? <audio controls autoPlay src={player} aria-label={say("试听", "Sample")} /> : null}
    </Field>
  );
}

// ---- Custom voices --------------------------------------------------------

function VoiceList({
  ctx,
  voices,
  onRenamed,
  onRemoved
}: {
  ctx: Ctx;
  voices: SpeechVoice[];
  onRenamed: (voice: SpeechVoice) => void;
  onRemoved: (id: string) => void;
}) {
  const { say } = ctx;
  return (
    <section className="voicesBlock" aria-labelledby="voices-custom">
      <h4 id="voices-custom">{say("自定义声音", "Custom voices")}</h4>
      {voices.length === 0 ? (
        <p className="studioHint">
          {say("还没有自定义声音。克隆或设计一个吧。", "No custom voices yet. Clone or design one below.")}
        </p>
      ) : (
        <ul className="voicesList">
          {voices.map((voice) => (
            <VoiceRow key={voice.id} ctx={ctx} voice={voice} onRenamed={onRenamed} onRemoved={onRemoved} />
          ))}
        </ul>
      )}
    </section>
  );
}

function VoiceRow({
  ctx,
  voice,
  onRenamed,
  onRemoved
}: {
  ctx: Ctx;
  voice: SpeechVoice;
  onRenamed: (voice: SpeechVoice) => void;
  onRemoved: (id: string) => void;
}) {
  const { say, urls } = ctx;
  const [busy, setBusy] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const designed = voice.origin === "designed";
  const created = voice.created_at ? new Date(voice.created_at) : null;
  const refKey = `ref:${voice.id}`;
  const previewKey = `preview:${voice.id}`;

  const fetchAudio = async (key: string, call: Promise<VoiceResult<Blob>>) => {
    setBusy(key);
    const blob = await ctx.run(call);
    setBusy(null);
    if (blob) urls.set(key, blob);
  };
  const rename = async () => {
    const name = (renaming ?? "").trim();
    if (!name) return;
    setBusy("rename");
    const updated = await ctx.run(ctx.api.updateVoice(voice.id, { name }));
    setBusy(null);
    if (updated) {
      onRenamed(updated);
      setRenaming(null);
      ctx.notify(say(`已改名为“${updated.name}”。`, `Renamed to “${updated.name}”.`));
    }
  };
  const remove = async () => {
    setBusy("delete");
    const result = await ctx.api.deleteVoice(voice.id);
    setBusy(null);
    if (!result.ok) {
      await ctx.run(Promise.resolve(result));
      return;
    }
    urls.drop(refKey);
    urls.drop(previewKey);
    onRemoved(voice.id);
    ctx.notify(say(`已删除“${voice.name}”。`, `Deleted “${voice.name}”.`));
  };

  return (
    <li className="voiceRow">
      <div className="voiceRowHead">
        <strong>{voice.name}</strong>
        <span className="voiceMeta">
          {[
            voice.languages.map((code) => languageLabel(code, say)).join(" · "),
            designed
              ? voice.design?.description
                ? say(`设计：${voice.design.description}`, `Designed: ${voice.design.description}`)
                : say("设计", "Designed")
              : say("录制", "Recorded"),
            created && !Number.isNaN(created.getTime()) ? created.toLocaleString(ctx.language) : "",
            voice.created_by ? say(`创建者 ${voice.created_by}`, `by ${voice.created_by}`) : ""
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>

      {renaming !== null ? (
        <form
          className="voicesInline"
          onSubmit={(event) => {
            event.preventDefault();
            void rename();
          }}
        >
          <input
            className="studioInput"
            aria-label={say(`“${voice.name}”的新名称`, `New name for ${voice.name}`)}
            value={renaming}
            maxLength={64}
            autoComplete="off"
            onChange={(event) => setRenaming(event.currentTarget.value)}
          />
          <button type="submit" className="studioButton" disabled={!renaming.trim() || busy === "rename"}>
            {say("保存名称", "Save name")}
          </button>
          <button type="button" className="studioButton quiet" onClick={() => setRenaming(null)}>
            {say("取消", "Cancel")}
          </button>
        </form>
      ) : null}

      {confirming ? (
        <div className="voiceConfirm" role="group" aria-label={say("确认删除", "Confirm delete")}>
          <p>
            {designed
              ? say(
                  `删除“${voice.name}”？它的样本和设计说明会一并删除，无法撤销。`,
                  `Delete “${voice.name}”? Its sample and design description go with it, and this can't be undone.`
                )
              : say(
                  `删除“${voice.name}”？参考录音和同意记录会一并删除，无法撤销。`,
                  `Delete “${voice.name}”? Its reference recording and consent record go with it, and this can't be undone.`
                )}
          </p>
          <div className="voicesInline">
            <button
              type="button"
              className="studioButton danger"
              disabled={busy === "delete"}
              onClick={() => void remove()}
            >
              <Trash size={14} aria-hidden="true" /> {say("确认删除", "Delete voice")}
            </button>
            <button type="button" className="studioButton quiet" onClick={() => setConfirming(false)}>
              {say("取消", "Cancel")}
            </button>
          </div>
        </div>
      ) : (
        <div className="voiceRowActions">
          {designed ? null : (
            <button
              type="button"
              className="studioButton"
              disabled={busy !== null}
              onClick={() => void fetchAudio(refKey, ctx.api.fetchReference(voice.id))}
            >
              <Play size={14} aria-hidden="true" /> {say("播放原声", "Play original")}
            </button>
          )}
          <button
            type="button"
            className="studioButton"
            disabled={busy !== null}
            onClick={() => void fetchAudio(previewKey, ctx.api.previewVoice(voice.id))}
          >
            <Play size={14} aria-hidden="true" />{" "}
            {busy === previewKey ? say("生成中…", "Generating…") : say("试听", "Preview")}
          </button>
          <button type="button" className="studioButton" onClick={() => setRenaming(voice.name)}>
            {say("改名", "Rename")}
          </button>
          <button type="button" className="studioButton danger" onClick={() => setConfirming(true)}>
            <Trash size={14} aria-hidden="true" /> {say("删除", "Delete")}
          </button>
        </div>
      )}

      {urls.get(refKey) ? (
        <audio controls autoPlay src={urls.get(refKey)} aria-label={say("原声", "Original recording")} />
      ) : null}
      {urls.get(previewKey) ? (
        <audio controls autoPlay src={urls.get(previewKey)} aria-label={say("试听", "Preview")} />
      ) : null}

      <details className="voiceConsent">
        <summary>{designed ? say("设计说明", "How it was designed") : say("同意记录", "Consent record")}</summary>
        {designed ? (
          <p>{voice.design?.description ?? say("没有记录描述。", "No description was recorded.")}</p>
        ) : (
          <>
            <p>
              <strong>{say("说话人：", "Speaker: ")}</strong>
              {voice.consent?.speaker ?? "—"}
            </p>
            <p>
              <strong>{say("声明：", "Statement: ")}</strong>
              {voice.consent?.statement ?? "—"}
            </p>
          </>
        )}
      </details>
    </li>
  );
}

// ---- Clone a voice --------------------------------------------------------

type Clip = { blob: Blob | null; seconds: number; source: "recording" | "file" };

function consentTemplate(language: Language, speaker: string, assistant: string): string {
  const who = speaker.trim();
  return localized(
    language,
    `我，${who || "（姓名）"}，同意我的声音被录制并克隆，供“${assistant || "Max"}”助手使用。`,
    `I, ${who || "(name)"}, agree that my voice may be recorded and cloned for use by the ${assistant || "Max"} assistant.`
  );
}

function CloneForm({ ctx, audio, assistantName }: { ctx: Ctx; audio: VoicesAudio; assistantName: string }) {
  const { say, urls, language } = ctx;
  const id = useId();
  const [name, setName] = useState("");
  const [gender, setGender] = useState<VoiceGender>("neutral");
  const [lang, setLang] = useState(language === "zh-CN" ? "zh" : "en");
  const [transcript, setTranscript] = useState("");
  const [speaker, setSpeaker] = useState("");
  const [statementText, setStatementText] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [clip, setClip] = useState<Clip | null>(null);
  const [recording, setRecording] = useState<"idle" | "starting" | "recording">("idle");
  const [progress, setProgress] = useState<RecorderProgress>({ level: 0, seconds: 0 });
  const [audioError, setAudioError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const recorder = useRef<WavRecorder | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  // Release the microphone if the panel goes away mid-recording, or while the
  // browser is still asking for it.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      recorder.current?.cancel();
      recorder.current = null;
    };
  }, []);

  const statement = statementText ?? consentTemplate(language, speaker, assistantName);
  const clipOk =
    Boolean(clip?.blob) && clip!.seconds >= RECORDING_MIN_SECONDS && clip!.seconds <= RECORDING_MAX_SECONDS;
  const problems = [
    !name.trim() && say("给声音起个名字", "name the voice"),
    !clipOk && say("录制或上传 5 到 30 秒的音频", "record or upload 5 to 30 seconds of audio"),
    !speaker.trim() && say("填写说话人姓名", "enter the speaker's name"),
    statement.trim().length < STATEMENT_MIN &&
      say(`同意声明至少 ${STATEMENT_MIN} 个字符`, `make the statement at least ${STATEMENT_MIN} characters`),
    !agreed && say("勾选同意确认", "tick the consent box")
  ].filter((item): item is string => typeof item === "string");

  const takeClip = (next: Clip | null) => {
    setClip(next);
    if (next?.blob) urls.set("clip", next.blob);
    else urls.drop("clip");
  };

  const startRecording = async () => {
    setAudioError(null);
    setRecording("starting");
    let stream: MediaStream;
    try {
      stream = await audio.getStream();
    } catch {
      setRecording("idle");
      setAudioError(
        say(
          "无法使用麦克风。请在浏览器里允许麦克风权限，或改为上传文件。",
          "Couldn't use the microphone. Allow microphone access in the browser, or upload a file instead."
        )
      );
      return;
    }
    if (!mounted.current) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const next = audio.createRecorder({
      onProgress: setProgress,
      onAutoStop: (recorded) => {
        recorder.current = null;
        setRecording("idle");
        takeClip({ ...recorded, source: "recording" });
      }
    });
    recorder.current = next;
    try {
      await next.start(stream);
      setProgress({ level: 0, seconds: 0 });
      setRecording("recording");
    } catch {
      stream.getTracks().forEach((track) => track.stop());
      recorder.current = null;
      setRecording("idle");
      setAudioError(
        say("无法开始录音。请重试，或改为上传文件。", "Couldn't start recording. Try again, or upload a file.")
      );
    }
  };

  const stopRecording = async () => {
    const active = recorder.current;
    recorder.current = null;
    if (!active) return;
    const recorded = await active.stop();
    setRecording("idle");
    takeClip({ ...recorded, source: "recording" });
  };

  const pickFile = async (file: File) => {
    setAudioError(null);
    try {
      const { samples, sampleRate } = await audio.decodeFile(file);
      const seconds = samples.length / sampleRate;
      // Re-encoded as WAV so the server always gets one format. A clip that is
      // too long is not encoded; the form says so instead.
      takeClip({
        blob: seconds <= RECORDING_MAX_SECONDS ? wavBlob(samples, sampleRate) : null,
        seconds,
        source: "file"
      });
    } catch {
      takeClip(null);
      setAudioError(explain({ kind: "invalid", message: "", code: "invalid_audio" }, say));
    }
  };

  const submit = async () => {
    if (problems.length || !clip?.blob) return;
    setBusy(true);
    const voice = await ctx.run(
      ctx.api.cloneVoice({
        name: name.trim(),
        gender,
        languages: [lang],
        transcript: transcript.trim() || undefined,
        consentStatement: statement.trim(),
        consentSpeaker: speaker.trim(),
        audio: clip.blob
      })
    );
    setBusy(false);
    if (!voice) return;
    ctx.addVoice(voice);
    ctx.notify(say(`已创建声音“${voice.name}”。`, `Created the voice “${voice.name}”.`));
    setName("");
    setTranscript("");
    setSpeaker("");
    setStatementText(null);
    setAgreed(false);
    takeClip(null);
  };

  const meter = Math.round(progress.level * 100);
  const clipUrl = urls.get("clip");
  return (
    <section className="voicesBlock" aria-labelledby="voices-clone">
      <h4 id="voices-clone">{say("克隆声音", "Clone a voice")}</h4>
      <p className="studioHint">
        {say(
          "录制或上传 5 到 30 秒清晰、安静环境下的说话声。",
          "Record or upload 5 to 30 seconds of clear speech in a quiet room."
        )}
      </p>

      <div className="voicesRecord">
        <div className="voicesInline">
          {recording === "recording" ? (
            <button type="button" className="studioButton primary" onClick={() => void stopRecording()}>
              <Stop size={14} aria-hidden="true" /> {say("停止录音", "Stop recording")}
            </button>
          ) : (
            <button
              type="button"
              className="studioButton"
              disabled={recording === "starting" || busy}
              onClick={() => void startRecording()}
            >
              <Microphone size={14} aria-hidden="true" /> {say("开始录音", "Record")}
            </button>
          )}
          <button
            type="button"
            className="studioButton"
            disabled={recording !== "idle" || busy}
            onClick={() => fileInput.current?.click()}
          >
            <UploadSimple size={14} aria-hidden="true" /> {say("上传文件", "Upload a file")}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="audio/*"
            className="visuallyHidden"
            tabIndex={-1}
            aria-label={say("上传音频文件", "Audio file")}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) void pickFile(file);
            }}
          />
        </div>
        {recording === "recording" ? (
          <div className="voicesRecording">
            <span className="voicesTimer" aria-label={say("已录制秒数", "Seconds recorded")}>
              {progress.seconds} / {RECORDING_MAX_SECONDS} s
            </span>
            <span
              className="voiceMeter"
              role="meter"
              aria-label={say("输入音量", "Input level")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={meter}
            >
              <span className="voiceMeterFill" style={{ width: `${meter}%` }} />
            </span>
          </div>
        ) : null}
        {audioError ? (
          <p className="studioError" role="alert">
            <WarningCircle size={16} aria-hidden="true" /> {audioError}
          </p>
        ) : null}
        {clip ? (
          <p className={`voicesClip${clipOk ? "" : " bad"}`}>
            {clip.seconds > RECORDING_MAX_SECONDS
              ? say(
                  `这段音频有 ${clip.seconds.toFixed(1)} 秒，太长了（最多 30 秒）。`,
                  `That clip is ${clip.seconds.toFixed(1)} s, which is too long (30 s at most).`
                )
              : clip.seconds < RECORDING_MIN_SECONDS
                ? say(
                    `这段音频只有 ${clip.seconds.toFixed(1)} 秒，至少需要 5 秒。`,
                    `That clip is only ${clip.seconds.toFixed(1)} s. It needs at least 5 s.`
                  )
                : say(`已准备好 ${clip.seconds.toFixed(1)} 秒的音频。`, `${clip.seconds.toFixed(1)} s of audio ready.`)}
          </p>
        ) : null}
        {clipUrl ? <audio controls src={clipUrl} aria-label={say("录音回放", "Recording playback")} /> : null}
      </div>

      <div className="studioPair">
        <Field label={say("名称", "Name")} htmlFor={`${id}-name`}>
          <input
            id={`${id}-name`}
            className="studioInput"
            value={name}
            maxLength={64}
            autoComplete="off"
            onChange={(event) => setName(event.currentTarget.value)}
          />
        </Field>
        <Field label={say("性别", "Gender")} htmlFor={`${id}-gender`}>
          <select
            id={`${id}-gender`}
            className="studioSelect"
            value={gender}
            onChange={(event) => setGender(event.currentTarget.value as VoiceGender)}
          >
            {GENDERS.map((value) => (
              <option key={value} value={value}>
                {genderLabel(value, say)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label={say("语言", "Language")} htmlFor={`${id}-lang`}>
        <select
          id={`${id}-lang`}
          className="studioSelect"
          value={lang}
          onChange={(event) => setLang(event.currentTarget.value)}
        >
          <option value="zh">{say("中文", "Chinese")}</option>
          <option value="en">{say("英语", "English")}</option>
        </select>
      </Field>
      <Field
        label={say("文字稿（可选）", "Transcript (optional)")}
        htmlFor={`${id}-transcript`}
        hint={say(
          "录音里说的话。留空则自动转写。",
          "What the recording says. Leave blank to transcribe it automatically."
        )}
      >
        <textarea
          id={`${id}-transcript`}
          className="studioTextarea"
          rows={2}
          maxLength={1000}
          value={transcript}
          onChange={(event) => setTranscript(event.currentTarget.value)}
        />
      </Field>

      <fieldset className="voicesConsent">
        <legend>{say("说话人同意", "Speaker's consent")}</legend>
        <Field label={say("说话人姓名", "Speaker's name")} htmlFor={`${id}-speaker`}>
          <input
            id={`${id}-speaker`}
            className="studioInput"
            value={speaker}
            maxLength={128}
            autoComplete="off"
            onChange={(event) => setSpeaker(event.currentTarget.value)}
          />
        </Field>
        <Field label={say("同意声明", "Consent statement")} htmlFor={`${id}-statement`}>
          <textarea
            id={`${id}-statement`}
            className="studioTextarea"
            rows={3}
            maxLength={STATEMENT_MAX}
            value={statement}
            onChange={(event) => setStatementText(event.currentTarget.value)}
          />
          {statementText !== null ? (
            <button type="button" className="linkButton" onClick={() => setStatementText(null)}>
              {say("恢复建议文本", "Reset to the suggested text")}
            </button>
          ) : null}
        </Field>
        <label className="studioCheck">
          <input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.currentTarget.checked)} />
          <span>
            {say(
              "我确认这是我自己的声音，或者我持有该声音主人的书面许可，可以克隆它。",
              "I confirm this is my own voice, or the voice of someone who has given me written permission to clone it."
            )}
          </span>
        </label>
      </fieldset>

      <div className="voicesInline">
        <button
          type="button"
          className="studioButton primary"
          disabled={problems.length > 0 || busy}
          aria-describedby={problems.length ? `${id}-todo` : undefined}
          onClick={() => void submit()}
        >
          {busy ? say("克隆中…", "Cloning…") : say("克隆声音", "Clone voice")}
        </button>
      </div>
      {problems.length ? (
        <p id={`${id}-todo`} className="studioHint">
          {say("还需要：", "Still needed: ")}
          {problems.join(say("；", "; "))}
          {say("。", ".")}
        </p>
      ) : null}
    </section>
  );
}

// ---- Design a voice -------------------------------------------------------

function DesignForm({ ctx }: { ctx: Ctx }) {
  const { say, urls, language } = ctx;
  const id = useId();
  const [description, setDescription] = useState("");
  const [text, setText] = useState("");
  const [lang, setLang] = useState(language === "zh-CN" ? "zh" : "en");
  const [busy, setBusy] = useState(false);
  const [candidates, setCandidates] = useState<DesignCandidate[]>([]);
  const [asked, setAsked] = useState(false);

  const generate = async () => {
    setBusy(true);
    for (const candidate of candidates) urls.drop(`cand:${candidate.id}`);
    setCandidates([]);
    const made = await ctx.run(
      ctx.api.designVoice({
        description: description.trim(),
        ...(text.trim() ? { text: text.trim() } : {}),
        language: lang,
        count: 3
      })
    );
    if (made) {
      await Promise.all(
        made.map(async (candidate) => {
          const blob = await ctx.run(ctx.api.fetchCandidateAudio(candidate.id));
          if (blob) urls.set(`cand:${candidate.id}`, blob);
        })
      );
      setCandidates(made);
      setAsked(true);
    }
    setBusy(false);
  };

  return (
    <section className="voicesBlock" aria-labelledby="voices-design">
      <h4 id="voices-design">{say("设计声音", "Design a voice")}</h4>
      <p className="studioHint">
        {say(
          "用文字描述想要的声音，生成三个候选，听完保存喜欢的。候选保留约 15 分钟。",
          "Describe the voice you want, generate three candidates, and save the one you like. Candidates are kept for about 15 minutes."
        )}
      </p>
      <Field label={say("声音描述", "Description")} htmlFor={`${id}-desc`}>
        <textarea
          id={`${id}-desc`}
          className="studioTextarea"
          rows={2}
          maxLength={300}
          value={description}
          placeholder={say("例如：温和的成年女声，语速适中", "For example: a warm, calm adult woman, medium pace")}
          onChange={(event) => setDescription(event.currentTarget.value)}
        />
      </Field>
      <div className="studioPair">
        <Field label={say("示例文字（可选）", "Sample text (optional)")} htmlFor={`${id}-text`}>
          <input
            id={`${id}-text`}
            className="studioInput"
            value={text}
            maxLength={300}
            autoComplete="off"
            onChange={(event) => setText(event.currentTarget.value)}
          />
        </Field>
        <Field label={say("语言", "Language")} htmlFor={`${id}-dlang`}>
          <select
            id={`${id}-dlang`}
            className="studioSelect"
            value={lang}
            onChange={(event) => setLang(event.currentTarget.value)}
          >
            <option value="zh">{say("中文", "Chinese")}</option>
            <option value="en">{say("英语", "English")}</option>
          </select>
        </Field>
      </div>
      <div className="voicesInline">
        <button
          type="button"
          className="studioButton primary"
          disabled={!description.trim() || busy}
          onClick={() => void generate()}
        >
          {busy ? say("生成中…", "Generating…") : say("生成候选", "Generate")}
        </button>
      </div>
      {candidates.length ? (
        <ul className="voicesList voicesCandidates">
          {candidates.map((candidate, index) => (
            <CandidateRow
              key={candidate.id}
              ctx={ctx}
              candidate={candidate}
              index={index}
              language={lang}
              onSaved={(voice) => {
                ctx.addVoice(voice);
                ctx.notify(say(`已保存声音“${voice.name}”。`, `Saved the voice “${voice.name}”.`));
              }}
            />
          ))}
        </ul>
      ) : asked ? (
        <p className="studioHint">{say("没有生成候选。", "No candidates came back.")}</p>
      ) : null}
    </section>
  );
}

function CandidateRow({
  ctx,
  candidate,
  index,
  language,
  onSaved
}: {
  ctx: Ctx;
  candidate: DesignCandidate;
  index: number;
  language: string;
  onSaved: (voice: SpeechVoice) => void;
}) {
  const { say, urls } = ctx;
  const [name, setName] = useState("");
  const [gender, setGender] = useState<VoiceGender>("neutral");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const url = urls.get(`cand:${candidate.id}`);
  const label = say(`候选 ${index + 1}`, `Candidate ${index + 1}`);
  const save = async () => {
    setBusy(true);
    const voice = await ctx.run(
      ctx.api.saveCandidate(candidate.id, { name: name.trim(), gender, languages: [language] })
    );
    setBusy(false);
    if (voice) {
      setSaved(true);
      onSaved(voice);
    }
  };
  return (
    <li className="voiceRow">
      <strong>{label}</strong>
      {url ? (
        <audio controls src={url} aria-label={label} />
      ) : (
        <p className="studioHint">{say("音频不可用。", "Audio unavailable.")}</p>
      )}
      {saved ? (
        <p className="studioHint">{say("已保存到自定义声音。", "Saved to your custom voices.")}</p>
      ) : (
        <div className="voicesInline">
          <input
            className="studioInput"
            aria-label={say(`${label}的名称`, `Name for ${label}`)}
            value={name}
            maxLength={64}
            autoComplete="off"
            placeholder={say("名称", "Name")}
            onChange={(event) => setName(event.currentTarget.value)}
          />
          <select
            className="studioSelect"
            aria-label={say(`${label}的性别`, `Gender for ${label}`)}
            value={gender}
            onChange={(event) => setGender(event.currentTarget.value as VoiceGender)}
          >
            {GENDERS.map((value) => (
              <option key={value} value={value}>
                {genderLabel(value, say)}
              </option>
            ))}
          </select>
          <button type="button" className="studioButton" disabled={!name.trim() || busy} onClick={() => void save()}>
            {busy ? say("保存中…", "Saving…") : say("保存为声音", "Save as voice")}
          </button>
        </div>
      )}
    </li>
  );
}

// ---- Pronunciation --------------------------------------------------------

type LexRow = { key: number; word: string; spoken: string };

function LexiconEditor({
  ctx,
  entries,
  loadError
}: {
  ctx: Ctx;
  entries: Record<string, string> | null;
  loadError: string | null;
}) {
  const { say } = ctx;
  const next = useRef(0);
  const toRows = (source: Record<string, string>): LexRow[] =>
    Object.entries(source).map(([word, spoken]) => ({ key: next.current++, word, spoken }));
  const [rows, setRows] = useState<LexRow[]>([]);
  const [baseline, setBaseline] = useState("{}");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!entries) return;
    setRows(toRows(entries));
    setBaseline(JSON.stringify(entries));
  }, [entries]);

  const current = Object.fromEntries(
    rows.filter((row) => row.word.trim()).map((row) => [row.word.trim(), row.spoken.trim()])
  );
  const dirty = JSON.stringify(current) !== baseline;
  const edit = (key: number, patch: Partial<LexRow>) => {
    setProblem(null);
    setRows((list) => list.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };
  const save = async () => {
    const words = rows.map((row) => row.word.trim()).filter(Boolean);
    if (new Set(words).size !== words.length) {
      setProblem(say("有重复的词条。", "Two entries use the same word."));
      return;
    }
    if (rows.some((row) => row.word.trim() && !row.spoken.trim())) {
      setProblem(say("每个词都要填写读法。", "Give every word a spoken form."));
      return;
    }
    setBusy(true);
    const saved = await ctx.run(ctx.api.putLexicon(current));
    setBusy(false);
    if (saved) {
      setRows(toRows(saved));
      setBaseline(JSON.stringify(saved));
      ctx.notify(say("发音表已保存。", "Pronunciations saved."));
    }
  };

  return (
    <section className="voicesBlock" aria-labelledby="voices-lexicon">
      <h4 id="voices-lexicon">{say("发音", "Pronunciation")}</h4>
      <p className="studioHint">
        {say(
          "让助手把某个词按你写的读法念出来，例如 “GPU” → “吉皮优”。保存后立即作用于所有声音。",
          "Make the assistant say a word the way you spell it out, for example “GPU” → “jee pee you”. Saved entries apply to every voice at once."
        )}
      </p>
      {loadError ? (
        <p className="studioError" role="alert">
          <WarningCircle size={16} aria-hidden="true" /> {loadError}
        </p>
      ) : entries === null ? (
        <p role="status">{say("正在读取发音表…", "Loading pronunciations…")}</p>
      ) : (
        <>
          {rows.length === 0 ? <p className="studioHint">{say("还没有词条。", "No entries yet.")}</p> : null}
          <ul className="voicesList lexList">
            {rows.map((row, index) => (
              <li key={row.key} className="lexRow">
                <input
                  className="studioInput"
                  aria-label={say(`词 ${index + 1}`, `Word ${index + 1}`)}
                  value={row.word}
                  maxLength={64}
                  autoComplete="off"
                  onChange={(event) => edit(row.key, { word: event.currentTarget.value })}
                />
                <input
                  className="studioInput"
                  aria-label={say(`读法 ${index + 1}`, `Spoken as ${index + 1}`)}
                  value={row.spoken}
                  maxLength={128}
                  autoComplete="off"
                  onChange={(event) => edit(row.key, { spoken: event.currentTarget.value })}
                />
                <button
                  type="button"
                  className="studioButton quiet"
                  aria-label={say(`删除词条 ${index + 1}`, `Remove entry ${index + 1}`)}
                  onClick={() => setRows((list) => list.filter((item) => item.key !== row.key))}
                >
                  <Trash size={14} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          {problem ? (
            <p className="studioError" role="alert">
              <WarningCircle size={16} aria-hidden="true" /> {problem}
            </p>
          ) : null}
          <div className="voicesInline">
            <button
              type="button"
              className="studioButton"
              onClick={() => setRows((list) => [...list, { key: next.current++, word: "", spoken: "" }])}
            >
              {say("添加词条", "Add entry")}
            </button>
            <button
              type="button"
              className="studioButton primary"
              disabled={!dirty || busy}
              onClick={() => void save()}
            >
              {busy ? say("保存中…", "Saving…") : say("保存发音表", "Save pronunciations")}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

// ---- Attributions ---------------------------------------------------------

function Attributions({ items, say }: { items: VoiceAttribution[]; say: Say }) {
  return (
    <section className="voicesBlock" aria-labelledby="voices-about">
      <h4 id="voices-about">{say("关于这些声音", "About the voices")}</h4>
      {items.length === 0 ? (
        <p className="studioHint">{say("暂无模型署名。", "No model credits to show.")}</p>
      ) : (
        <ul className="voicesAttributions">
          {items.map((item) => (
            <li key={item.model}>
              {item.text}
              {item.weights_license ? <small> · {item.weights_license}</small> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
