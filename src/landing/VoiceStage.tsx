import { ArrowCounterClockwise, Pause, Play, SpeakerHigh, SpeakerSlash } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLanguage } from "../components/LanguageToggle";
import { localized } from "../lib/i18n";
import { REPOSITORY_URL } from "../lib/routes";
import { useOnScreen } from "./motion";
import { ScreenRecording } from "./ScreenRecording";
import clipData from "./voice-stage-clips.json";

type ClipId = keyof typeof clipData;
type MomentId = "talk" | "languages" | "clone" | "design";
type Who = "you" | "max" | "note";

type Item = {
  clip?: ClipId;
  who: Who;
  name: string;
  text: string;
  /** Shown above the words: what was asked for. */
  prompt?: string;
  /** A button that jumps to this beat. */
  chip?: string;
  /** Play only this many seconds of the clip: the speaker was interrupted. */
  cut?: number;
  /** Start this long before the previous beat ends. */
  overlap?: number;
  /** Length of a beat with no audio. */
  seconds?: number;
};

type Beat = Item & { start: number; end: number; length: number };
type Moment = { id: MomentId; title: string; caption: string; beats: Beat[]; total: number; lanes: boolean };

const GAP = 0.45;
/** Rest at the end of a moment before the next one. */
const HOLD = 1.4;
const LEVELS_PER_SECOND = 12;
const UNITS_PER_SECOND = 12;
const MOMENTS: readonly MomentId[] = ["talk", "languages", "clone", "design"];

function place(items: Item[]): { beats: Beat[]; total: number } {
  const beats: Beat[] = [];
  let cursor = 0;
  for (const item of items) {
    const length = item.clip ? clipData[item.clip].seconds : (item.seconds ?? 1);
    const played = item.cut ?? length;
    const start = beats.length ? cursor + (item.overlap ? -item.overlap : GAP) : 0;
    beats.push({ ...item, start, end: start + played, length });
    cursor = Math.max(cursor, start + played);
  }
  return { beats, total: cursor };
}

function buildMoment(id: MomentId, en: boolean): Moment {
  const say = (zh: string, english: string) => (en ? english : zh);
  const you = say("你", "You");
  const max = "Max";
  if (id === "talk") {
    const items: Item[] = en
      ? [
          { clip: "talk-en-1", who: "you", name: you, text: "Max, how far is the next fuel stop?" },
          {
            clip: "talk-en-2",
            who: "max",
            name: max,
            text: "About twelve kilometers. There are three stations on this road, and the first one is just past the bridge.",
            cut: 3.1
          },
          { clip: "talk-en-3", who: "you", name: you, text: "Just the closest one.", overlap: 0.45 },
          { clip: "talk-en-4", who: "max", name: max, text: "Twelve kilometers, on your right." }
        ]
      : [
          { clip: "talk-zh-1", who: "you", name: you, text: "Max，下一个加油站还有多远？" },
          {
            clip: "talk-zh-2",
            who: "max",
            name: max,
            text: "大约十二公里。这条路上有三个加油站，第一个就在桥后面。",
            cut: 3.9
          },
          { clip: "talk-zh-3", who: "you", name: you, text: "说最近的就行。", overlap: 0.45 },
          { clip: "talk-zh-4", who: "max", name: max, text: "十二公里，在你右手边。" }
        ];
    return {
      id,
      title: say("对话", "Talk"),
      caption: say("随时打断，Max 会停下来听你说。", "Cut in whenever you like. Max stops and listens."),
      lanes: true,
      ...place(items)
    };
  }
  if (id === "languages") {
    const lines: Array<[ClipId, string, string]> = [
      ["lang-en", "English", "Hi, I'm Max. Where are we going today?"],
      ["lang-zh", "中文", "你好，我是 Max。今天我们去哪里？"],
      ["lang-ja", "日本語", "こんにちは、マックスです。今日はどこへ行きましょうか。"],
      ["lang-es", "Español", "Hola, soy Max. ¿A dónde vamos hoy?"],
      ["lang-fr", "Français", "Bonjour, je suis Max. Où allons-nous aujourd'hui ?"],
      ["lang-it", "Italiano", "Ciao, sono Max. Dove andiamo oggi?"],
      ["lang-pt", "Português", "Olá, eu sou o Max. Para onde vamos hoje?"],
      ["lang-hi", "हिन्दी", "नमस्ते, मैं मैक्स हूँ। आज हम कहाँ चलें?"]
    ];
    return {
      id,
      title: say("语言", "Languages"),
      caption: say("八种语言，都在你自己的机器上运行。", "Eight languages, all running on your own machine."),
      lanes: false,
      ...place(lines.map(([clip, chip, text]) => ({ clip, who: "max" as const, name: chip, chip, text })))
    };
  }
  if (id === "clone") {
    const zhLine = "现在我可以用同样的声音，说出你写的任何话。";
    const enLine = "Now I can say anything you write, in the same voice.";
    const newVoice = say("新声音", "New voice");
    const first: Item = en
      ? { clip: "clone-en", who: "max", name: newVoice, text: enLine, chip: say("听新声音", "Hear it") }
      : { clip: "clone-zh", who: "max", name: newVoice, text: zhLine, chip: say("听新声音", "Hear it") };
    const second: Item = en
      ? { clip: "clone-zh", who: "max", name: newVoice, text: zhLine, chip: say("换一种语言", "In Chinese") }
      : { clip: "clone-en", who: "max", name: newVoice, text: enLine, chip: "English" };
    return {
      id,
      title: say("克隆", "Clone"),
      caption: say(
        "几秒录音，经说话人同意，就是一个新声音。",
        "A few seconds of speech, with consent, becomes a voice."
      ),
      lanes: false,
      ...place([
        {
          clip: "clone-source",
          who: "you",
          name: say("示例录音", "Sample"),
          text: "This is a sample voice for the Max demo. It takes only a few seconds of clear speech to make a new voice.",
          chip: say("录一段", "Record")
        },
        {
          who: "note",
          name: say("同意", "Consent"),
          text: say("说话人的同意声明已保存。", "The speaker's consent is saved with the voice."),
          chip: say("确认同意", "Consent"),
          seconds: 1.6
        },
        first,
        second
      ])
    };
  }
  const line = say("你好，我是你的新声音。我们出发吧？", "Hi, I'm your new voice. Shall we go?");
  const suffix = en ? "en" : "zh";
  const voices: Array<[ClipId, string, string]> = [
    [
      `design-low-${suffix}` as ClipId,
      say("低沉", "Low"),
      say("声音低沉、沉稳的中年男性", "A calm, low-pitched middle-aged man")
    ],
    [
      `design-bright-${suffix}` as ClipId,
      say("明亮", "Bright"),
      say("声音明亮、开朗的年轻女性", "A bright, cheerful young woman")
    ],
    [
      `design-warm-${suffix}` as ClipId,
      say("温暖", "Warm"),
      say("声音温暖、柔和的讲故事老人", "A warm, gentle elderly storyteller")
    ]
  ];
  return {
    id,
    title: say("设计", "Design"),
    caption: say("写一句描述，就能听到这个声音。", "Describe a voice and hear it."),
    lanes: false,
    ...place(
      voices.map(([clip, chip, prompt]) => ({ clip, who: "max" as const, name: chip, chip, prompt, text: line }))
    )
  };
}

/** Plays decoded clips on one clock, so two people can talk over each other. */
class StageAudio {
  private context: AudioContext | null = null;
  private buffers = new Map<ClipId, AudioBuffer>();
  private sounding = new Map<string, { source: AudioBufferSourceNode; gain: GainNode }>();

  /** Must run inside the click that turned sound on, or browsers keep the context suspended. */
  unlock(): void {
    this.context ??= new AudioContext();
    void this.context.resume();
  }

  async load(clips: ClipId[]): Promise<void> {
    const context = this.context;
    if (!context) return;
    await Promise.all(
      clips
        .filter((clip) => !this.buffers.has(clip))
        .map(async (clip) => {
          const response = await fetch(`/audio/stage/${clip}.mp3`);
          if (!response.ok) throw new Error(`Could not load ${clip}`);
          this.buffers.set(clip, await context.decodeAudioData(await response.arrayBuffer()));
        })
    );
  }

  isSounding(key: string): boolean {
    return this.sounding.has(key);
  }

  start(key: string, clip: ClipId, offset: number, seconds: number): void {
    const context = this.context;
    const buffer = this.buffers.get(clip);
    if (!context || !buffer || seconds <= 0.02) return;
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    source.connect(gain).connect(context.destination);
    // A short fade, so a speaker who is cut off does not end in a click.
    const stopAt = context.currentTime + seconds;
    gain.gain.setValueAtTime(1, Math.max(context.currentTime, stopAt - 0.04));
    gain.gain.linearRampToValueAtTime(0, stopAt);
    source.onended = () => {
      if (this.sounding.get(key)?.source === source) this.sounding.delete(key);
    };
    source.start(0, offset, seconds);
    this.sounding.set(key, { source, gain });
  }

  stop(key: string): void {
    const node = this.sounding.get(key);
    if (!node) return;
    this.sounding.delete(key);
    node.source.onended = null;
    node.source.stop();
    node.source.disconnect();
    node.gain.disconnect();
  }

  stopAll(): void {
    for (const key of [...this.sounding.keys()]) this.stop(key);
  }

  close(): void {
    this.stopAll();
    void this.context?.close();
    this.context = null;
  }
}

function Wave({ moment }: { moment: Moment }) {
  const width = moment.total * UNITS_PER_SECOND;
  const bars: Array<{ x: number; y: number; height: number; who: Who }> = [];
  for (const beat of moment.beats) {
    if (!beat.clip) continue;
    const levels = clipData[beat.clip].levels;
    const shown = Math.min(levels.length, Math.round((beat.end - beat.start) * LEVELS_PER_SECOND));
    const laneCenter = moment.lanes ? (beat.who === "you" ? 27 : 73) : 50;
    const reach = moment.lanes ? 44 : 92;
    for (let index = 0; index < shown; index += 1) {
      const height = 3 + (Number(levels[index]) / 9) * (reach - 3);
      bars.push({
        x: (beat.start + index / LEVELS_PER_SECOND) * UNITS_PER_SECOND,
        y: laneCenter - height / 2,
        height,
        who: beat.who
      });
    }
  }
  return (
    <svg viewBox={`0 0 ${width} 100`} preserveAspectRatio="none" focusable="false">
      {bars.map((bar) => (
        <rect
          key={`${bar.x}-${bar.who}`}
          className={bar.who}
          x={bar.x}
          y={bar.y}
          width={0.62}
          height={bar.height}
          rx={0.2}
        />
      ))}
    </svg>
  );
}

/** A real recording of the Studio. */
function StudioClip() {
  const { language } = useLanguage();
  const say = (zh: string, en: string) => localized(language, zh, en);
  const code = language === "en-US" ? "en" : "zh";
  return (
    <figure className="stageStudio" data-reveal="">
      <figcaption>
        <h3>{say("在工作室里完成", "Make it in the Studio")}</h3>
        <p>{say("描述、试听、保存，不用写代码。", "Describe it, listen, save it. No code.")}</p>
      </figcaption>
      <ScreenRecording
        key={code}
        src={`/video/studio-design-${code}.mp4`}
        poster={`/video/studio-design-${code}.jpg`}
        label={say("在 Max 工作室里设计声音的录屏", "Screen recording of designing a voice in the Max Studio")}
      />
    </figure>
  );
}

/** Real clips from Max Speech, shown as the waveforms they are. It runs silently until a
 *  visitor turns the sound on, because browsers do not allow audio before a click. */
export function VoiceStage() {
  const { language } = useLanguage();
  const say = (zh: string, en: string) => localized(language, zh, en);
  const en = language === "en-US";
  const [momentId, setMomentId] = useState<MomentId>("talk");
  const moment = useMemo(() => buildMoment(momentId, en), [momentId, en]);
  const [playing, setPlaying] = useState(false);
  const [finished, setFinished] = useState(false);
  const [sound, setSound] = useState(false);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [soundFailed, setSoundFailed] = useState(false);
  const [view, setView] = useState({ index: 0, chars: Number.MAX_SAFE_INTEGER });
  const stageRef = useRef<HTMLDivElement | null>(null);
  const litRef = useRef<HTMLDivElement | null>(null);
  const headRef = useRef<HTMLSpanElement | null>(null);
  const timeRef = useRef(0);
  const pinnedRef = useRef(false);
  const audioRef = useRef<StageAudio | null>(null);
  const onScreen = useOnScreen(stageRef, "0px", false);
  const momentKey = `${moment.id}-${language}`;
  const audioReady = !sound || loadedFor === momentKey;

  const paint = useCallback(
    (time: number) => {
      const percent = Math.min(100, (time / moment.total) * 100);
      if (litRef.current) litRef.current.style.clipPath = `inset(0 ${100 - percent}% 0 0)`;
      if (headRef.current) headRef.current.style.left = `${percent}%`;
      let index = 0;
      moment.beats.forEach((beat, position) => {
        if (time >= beat.start) index = position;
      });
      const beat = moment.beats[index]!;
      const progress = Math.min(1, (time - beat.start) / (beat.clip ? beat.length : 0.5));
      const chars = Math.max(1, Math.ceil(beat.text.length * progress));
      setView((current) => (current.index === index && current.chars === chars ? current : { index, chars }));
    },
    [moment]
  );

  useEffect(() => {
    if (!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) setPlaying(true);
    return () => audioRef.current?.close();
  }, []);

  useEffect(() => {
    if (!sound) return;
    let alive = true;
    const clips = moment.beats.flatMap((beat) => (beat.clip ? [beat.clip] : []));
    audioRef.current?.load(clips).then(
      () => {
        if (alive) setLoadedFor(momentKey);
      },
      () => {
        if (!alive) return;
        setSound(false);
        setSoundFailed(true);
      }
    );
    return () => {
      alive = false;
    };
  }, [sound, moment, momentKey]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!playing || !onScreen || !audioReady) {
      audio?.stopAll();
      return;
    }
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const delta = Math.min(0.1, (now - last) / 1000);
      last = now;
      timeRef.current += delta;
      const time = timeRef.current;
      if (sound && audio) {
        moment.beats.forEach((beat, index) => {
          if (!beat.clip) return;
          const key = `${momentKey}-${index}`;
          const active = time >= beat.start && time < beat.end;
          if (active && !audio.isSounding(key)) audio.start(key, beat.clip, time - beat.start, beat.end - time);
          if (!active) audio.stop(key);
        });
      }
      if (time >= moment.total + HOLD) {
        if (sound) {
          timeRef.current = moment.total;
          paint(moment.total);
          audio?.stopAll();
          setPlaying(false);
          setFinished(true);
          return;
        }
        timeRef.current = 0;
        if (!pinnedRef.current) {
          setMomentId(MOMENTS[(MOMENTS.indexOf(moment.id) + 1) % MOMENTS.length]!);
          return;
        }
      }
      paint(Math.min(timeRef.current, moment.total));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      audio?.stopAll();
    };
  }, [playing, onScreen, audioReady, sound, moment, momentKey, paint]);

  const seek = (time: number) => {
    audioRef.current?.stopAll();
    timeRef.current = time;
    pinnedRef.current = true;
    setFinished(false);
    setPlaying(true);
    paint(time);
  };

  const chooseMoment = (id: MomentId) => {
    audioRef.current?.stopAll();
    timeRef.current = 0;
    pinnedRef.current = true;
    setFinished(false);
    setPlaying(true);
    setMomentId(id);
    setView({ index: 0, chars: 1 });
  };

  const toggleSound = () => {
    if (sound) {
      setSound(false);
      audioRef.current?.stopAll();
      return;
    }
    audioRef.current ??= new StageAudio();
    audioRef.current.unlock();
    setSoundFailed(false);
    setSound(true);
    pinnedRef.current = true;
    const beat = moment.beats[view.index];
    timeRef.current = finished ? 0 : (beat?.start ?? 0);
    setFinished(false);
    setPlaying(true);
  };

  const beat = moment.beats[view.index] ?? moment.beats[0]!;
  const shown = Math.min(view.chars, beat.text.length);
  const wasCut = Boolean(beat.cut) && shown >= Math.floor(beat.text.length * (beat.cut! / beat.length));
  const visibleChars = beat.cut ? Math.min(shown, Math.floor(beat.text.length * (beat.cut / beat.length))) : shown;
  const chips = moment.beats.filter((item) => item.chip);

  return (
    <section className="siteSection speechStageSection" aria-labelledby="speech">
      <header className="sectionHead" data-reveal="">
        <h2 id="speech">{say("Max Speech：声音留在本机", "Max Speech: a voice that stays on your machine")}</h2>
      </header>
      <div className="voiceStage" ref={stageRef} data-reveal="">
        <div className="stageTabs" role="group" aria-label={say("选择演示", "Choose a demo")}>
          {MOMENTS.map((id) => (
            <button key={id} type="button" aria-pressed={id === moment.id} onClick={() => chooseMoment(id)}>
              {buildMoment(id, en).title}
            </button>
          ))}
        </div>
        <p className="stageCaption">{moment.caption}</p>

        <div className={`stageTrack${moment.lanes ? " lanes" : ""}`} aria-hidden="true">
          {moment.lanes ? (
            <>
              <span className="stageLane you">{say("你", "You")}</span>
              <span className="stageLane max">Max</span>
            </>
          ) : null}
          <button
            type="button"
            tabIndex={-1}
            className="stageWave"
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              seek(((event.clientX - box.left) / box.width) * moment.total);
            }}
          >
            <span className="stageWaveBase">
              <Wave moment={moment} />
            </span>
            <span className="stageWaveLit" ref={litRef}>
              <Wave moment={moment} />
            </span>
            <span className="stagePlayhead" ref={headRef} />
          </button>
        </div>

        <div className={`stageWords ${beat.who}`}>
          {beat.prompt ? <p className="stagePrompt">“{beat.prompt}”</p> : null}
          <strong>{beat.name}</strong>
          <p lang={moment.id === "languages" ? undefined : en ? "en" : "zh"}>
            {beat.text.slice(0, visibleChars)}
            {wasCut ? <span className="stageCut">…</span> : null}
            <span className="stageGhost" aria-hidden="true">
              {beat.text.slice(visibleChars)}
            </span>
          </p>
        </div>

        <div className="stageControls">
          <button type="button" className="siteButton small" onClick={toggleSound} aria-pressed={sound}>
            {sound ? <SpeakerHigh size={16} aria-hidden="true" /> : <SpeakerSlash size={16} aria-hidden="true" />}
            {sound
              ? audioReady
                ? say("声音已开", "Sound on")
                : say("正在加载", "Loading sound")
              : say("打开声音", "Turn sound on")}
          </button>
          <button
            type="button"
            className="siteButton quiet small stageIcon"
            aria-label={finished ? say("重新播放", "Play again") : playing ? say("暂停", "Pause") : say("播放", "Play")}
            onClick={() => {
              if (finished) seek(0);
              else setPlaying((value) => !value);
            }}
          >
            {finished ? (
              <ArrowCounterClockwise size={16} aria-hidden="true" />
            ) : playing ? (
              <Pause size={16} aria-hidden="true" />
            ) : (
              <Play size={16} aria-hidden="true" />
            )}
          </button>
          {chips.length ? (
            <div className="stageChips" role="group" aria-label={moment.title}>
              {chips.map((item) => (
                <button key={item.chip} type="button" aria-pressed={item === beat} onClick={() => seek(item.start)}>
                  {item.chip}
                </button>
              ))}
            </div>
          ) : null}
          {soundFailed ? (
            <span className="stageError" role="status">
              {say("声音加载失败，请重试。", "Sound could not load. Try again.")}
            </span>
          ) : null}
        </div>
      </div>
      <StudioClip />
      <p className="stageFootnote" data-reveal="">
        {say(
          "所有音频都由 Max Speech 在 Apple M5 Max 上生成，声音均为合成。克隆必须提供说话人的同意声明，声音设计需要 24 GB 内存的 Apple 芯片。Max Speech 用于自行部署，不包含在 Max Cloud 中。",
          "Every clip here was made by Max Speech on an Apple M5 Max, and all voices are synthetic. Cloning requires the speaker's consent statement. Voice design needs Apple silicon with 24 GB of memory. Max Speech is for self-hosting and is not part of Max Cloud."
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
