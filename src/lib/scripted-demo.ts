// The landing page's scripted preview: a short conversation that plays out in
// the real Visor with no relay, no account and no microphone. Every line is
// written here; nothing is generated. One script per kind of device, because
// what a wearer asks a helmet is not what they ask a pair of glasses.

import { useEffect, useMemo, useState } from "react";
import type { TurnState } from "../components/VisorVisual";
import { findDevice } from "./device-catalog";

type Line = { zh: string; en: string };

type DemoPhase = "idle" | "connecting" | TurnState;

type DemoHazard = { direction: Line; label: Line; advice: Line };
export type DemoAction = { kind: "navigation" | "camera" | "torch" | "music" | "call"; label: Line };

type Beat = {
  /** How long the beat lasts, in ms. */
  duration: number;
  phase: DemoPhase;
  /** Microphone level while the wearer speaks. */
  level?: number;
  say?: { who: "wearer" | "assistant"; line: Line };
  /** Raise (or, with null, clear) a safety alert. */
  hazard?: DemoHazard | null;
  /** Show (or, with null, clear) a device action. */
  action?: DemoAction | null;
};

export type DemoScript = "helmet" | "glasses" | "assistive" | "headset";

const wearer = (zh: string, en: string) => ({ who: "wearer" as const, line: { zh, en } });
const assistant = (zh: string, en: string) => ({ who: "assistant" as const, line: { zh, en } });

const OPENING: Beat[] = [
  { duration: 1600, phase: "idle", hazard: null, action: null },
  { duration: 1100, phase: "connecting" },
  { duration: 900, phase: "listening" }
];

const SCRIPTS: Record<DemoScript, Beat[]> = {
  helmet: [
    ...OPENING,
    {
      duration: 1700,
      phase: "hearing",
      level: 0.32,
      say: wearer("Max，前面天气怎么样？", "Max, what's the weather ahead?")
    },
    { duration: 1100, phase: "thinking" },
    {
      duration: 3000,
      phase: "speaking",
      say: assistant(
        "接下来一小时没有雨，过桥时侧风会大一些。",
        "Dry for the next hour. Expect a crosswind on the bridge."
      )
    },
    { duration: 1500, phase: "hearing", level: 0.28, say: wearer("导航去公司。", "Take me to the office.") },
    { duration: 900, phase: "thinking" },
    {
      duration: 2600,
      phase: "speaking",
      say: assistant("开始导航，三百米后右转。", "Starting navigation. Turn right in 300 metres."),
      action: { kind: "navigation", label: { zh: "导航已开始", en: "Navigation started" } }
    },
    {
      duration: 3200,
      phase: "speaking",
      say: assistant("后方车辆快速接近，保持车道。", "Vehicle closing fast behind. Hold your lane."),
      hazard: {
        direction: { zh: "后方", en: "Rear" },
        label: { zh: "后方快速接近", en: "Closing fast behind" },
        advice: { zh: "保持车道，不要急刹。", en: "Hold your lane and avoid hard braking." }
      }
    },
    { duration: 2200, phase: "listening", hazard: null }
  ],
  glasses: [
    ...OPENING,
    { duration: 1600, phase: "hearing", level: 0.3, say: wearer("我面前这是什么？", "What am I looking at?") },
    {
      duration: 600,
      phase: "thinking",
      action: { kind: "camera", label: { zh: "拍了一张照片", en: "Took one photo" } }
    },
    { duration: 900, phase: "thinking" },
    {
      duration: 3000,
      phase: "speaking",
      say: assistant(
        "一张公交站牌，下一班 12 路三分钟后到。",
        "A bus stop sign. The next number 12 is due in three minutes."
      )
    },
    { duration: 1400, phase: "hearing", level: 0.26, say: wearer("播放我的歌单。", "Play my playlist."), action: null },
    { duration: 800, phase: "thinking" },
    {
      duration: 2200,
      phase: "speaking",
      say: assistant("好的，开始播放。", "Playing it now."),
      action: { kind: "music", label: { zh: "音乐已播放", en: "Music playing" } }
    },
    {
      duration: 3000,
      phase: "speaking",
      say: assistant("左侧有自行车靠近。", "Cyclist coming up on your left."),
      hazard: {
        direction: { zh: "左侧", en: "Left" },
        label: { zh: "左侧有自行车", en: "Cyclist on your left" },
        advice: { zh: "先停一下再过马路。", en: "Wait a moment before crossing." }
      }
    },
    { duration: 2200, phase: "listening", hazard: null }
  ],
  assistive: [
    ...OPENING,
    { duration: 1600, phase: "hearing", level: 0.3, say: wearer("我前面有什么？", "What's in front of me?") },
    {
      duration: 600,
      phase: "thinking",
      action: { kind: "camera", label: { zh: "拍了一张照片", en: "Took one photo" } }
    },
    { duration: 900, phase: "thinking" },
    {
      duration: 3800,
      phase: "speaking",
      say: assistant(
        "十二点方向约两米，有两级向下的台阶。右手边有扶手。",
        "Two steps down at twelve o'clock, about two metres away. There is a handrail on your right."
      ),
      hazard: {
        direction: { zh: "前方", en: "Ahead" },
        label: { zh: "前方有台阶", en: "Steps down ahead" },
        advice: { zh: "约两米，扶手在右侧。", en: "About two metres. Handrail on the right." }
      }
    },
    { duration: 1500, phase: "hearing", level: 0.28, say: wearer("打开手电筒。", "Turn on the torch."), hazard: null },
    { duration: 700, phase: "thinking", action: null },
    {
      duration: 2200,
      phase: "speaking",
      say: assistant("手电筒已打开。", "Torch is on."),
      action: { kind: "torch", label: { zh: "手电筒已打开", en: "Torch on" } }
    },
    { duration: 2200, phase: "listening" }
  ],
  headset: [
    ...OPENING,
    { duration: 1600, phase: "hearing", level: 0.3, say: wearer("给 Alex 打电话。", "Call Alex.") },
    { duration: 900, phase: "thinking" },
    {
      duration: 2400,
      phase: "speaking",
      say: assistant("正在呼叫 Alex。", "Calling Alex."),
      action: { kind: "call", label: { zh: "正在呼叫 Alex", en: "Calling Alex" } }
    },
    { duration: 1500, phase: "hearing", level: 0.26, say: wearer("出口在哪？", "Where's the exit?"), action: null },
    { duration: 900, phase: "thinking" },
    {
      duration: 3600,
      phase: "speaking",
      say: assistant("在你身后。转身前先注意周围空间。", "Behind you. Mind the space around you before you turn."),
      hazard: {
        direction: { zh: "身边", en: "Nearby" },
        label: { zh: "注意真实空间", en: "Mind the real room" },
        advice: { zh: "转身或伸手前先确认周围。", en: "Check around you before you turn or reach." }
      }
    },
    { duration: 2200, phase: "listening", hazard: null }
  ]
};

/** Which script suits a device preset. */
export function scriptForDevice(deviceId: string): DemoScript {
  if (deviceId === "assistive-glasses") return "assistive";
  const family = findDevice(deviceId).family;
  if (family === "helmet") return "helmet";
  if (deviceId === "vr-headset") return "headset";
  return "glasses";
}

type DemoCaption = { id: number; who: "wearer" | "assistant"; line: Line };

export type DemoFrame = {
  phase: DemoPhase;
  level: number;
  captions: DemoCaption[];
  hazard: DemoHazard | null;
  action: DemoAction | null;
};

/** The state after `count` beats of a script have started (pure, for tests
 *  and for the player below). Captions keep the last four lines. */
export function demoFrame(script: DemoScript, count: number): DemoFrame {
  const beats = SCRIPTS[script];
  const frame: DemoFrame = { phase: "idle", level: 0, captions: [], hazard: null, action: null };
  const index = ((count % beats.length) + beats.length) % beats.length;
  for (let i = 0; i <= index; i += 1) {
    const beat = beats[i]!;
    frame.phase = beat.phase;
    frame.level = beat.level ?? 0;
    if (beat.say) frame.captions = [...frame.captions, { id: i, ...beat.say }].slice(-4);
    if (beat.hazard !== undefined) frame.hazard = beat.hazard;
    if (beat.action !== undefined) frame.action = beat.action;
  }
  return frame;
}

export function scriptLength(script: DemoScript): number {
  return SCRIPTS[script].length;
}

/** Plays a script in a loop. Pauses while the tab is hidden or `playing` is
 *  false. The microphone level wobbles while the wearer speaks so the lens
 *  moves like a voice. */
export function useScriptedDemo(script: DemoScript, playing = true): DemoFrame {
  // The beat belongs to a script; switching scripts starts the new one over.
  const [position, setPosition] = useState({ script, beat: 0 });
  const beat = position.script === script ? position.beat : 0;
  const [wobble, setWobble] = useState(0);
  const [visible, setVisible] = useState(() => typeof document === "undefined" || !document.hidden);

  useEffect(() => {
    const onVisibility = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const duration = SCRIPTS[script][beat % SCRIPTS[script].length]!.duration;
  useEffect(() => {
    if (!playing || !visible) return;
    const timer = window.setTimeout(() => setPosition({ script, beat: (beat + 1) % SCRIPTS[script].length }), duration);
    return () => window.clearTimeout(timer);
  }, [beat, duration, playing, script, visible]);

  const frame = useMemo(() => demoFrame(script, beat), [script, beat]);
  const speaking = frame.phase === "hearing";
  useEffect(() => {
    if (!speaking || !playing || !visible) return;
    const timer = window.setInterval(() => setWobble((value) => value + 1), 140);
    return () => window.clearInterval(timer);
  }, [speaking, playing, visible]);

  if (!speaking) return frame;
  const level = frame.level * (0.55 + 0.45 * Math.abs(Math.sin(wobble * 1.7)));
  return { ...frame, level };
}
