// What the client knows about the framework without asking a relay: the
// device presets, the voice backends and what each needs, the languages, and
// the equaliser presets. The landing page and the public configurator run
// with no relay at all; the Studio prefers the live relay's lists and falls
// back to these. Mirrors server/device-presets.ts, server/providers/catalog.ts
// and server/audio-eq.ts — keep them in step.

import {
  EQUALIZER_FREQUENCIES,
  type AssistantDevice,
  type VoiceEqualizerOptions,
  type VoiceVisualizer
} from "../../shared/agent";

type Bilingual = { zh: string; en: string };

export type DeviceInfo = {
  id: string;
  family: AssistantDevice;
  label: Bilingual;
  template: string;
  visualizer: VoiceVisualizer;
  equalizer: string;
  /** One line on what changes for this device. */
  note: Bilingual;
};

export const DEVICES: readonly DeviceInfo[] = [
  {
    id: "motorcycle-helmet",
    family: "helmet",
    label: { zh: "摩托车头盔", en: "Motorcycle helmet" },
    template: "visor",
    visualizer: "wave",
    equalizer: "wind",
    note: {
      zh: "导航、天气和路况优先；风噪均衡让人声压过风声。",
      en: "Routes, weather and road conditions first, with a voice tuned to cut through wind."
    }
  },
  {
    id: "bicycle-helmet",
    family: "helmet",
    label: { zh: "自行车头盔", en: "Bicycle helmet" },
    template: "daylight",
    visualizer: "bars",
    equalizer: "wind",
    note: {
      zh: "回答更短，用力爬坡时不闲聊，让你听得见车流；日光界面。",
      en: "Shorter answers and no small talk on a climb, so you still hear traffic. Daylight look."
    }
  },
  {
    id: "sunglasses",
    family: "glasses",
    label: { zh: "智能太阳镜", en: "Sunglasses" },
    template: "daylight",
    visualizer: "bars",
    equalizer: "open-ear",
    note: {
      zh: "开放式扬声器旁人可能听见，念私人内容前先问；为阳光下设计的界面。",
      en: "Open-ear speakers can be overheard, so it asks before reading anything private. Built for sunlight."
    }
  },
  {
    id: "smart-glasses",
    family: "glasses",
    label: { zh: "智能眼镜", en: "Smart glasses" },
    template: "visor",
    visualizer: "wave",
    equalizer: "open-ear",
    note: {
      zh: "处理眼前的事：路线、提醒、看到的东西；为小扬声器补足低音。",
      en: "Help with what is in front of you: directions, reminders, what you are looking at. Body for small speakers."
    }
  },
  {
    id: "assistive-glasses",
    family: "glasses",
    label: { zh: "助视眼镜", en: "Assistive glasses" },
    template: "beacon",
    visualizer: "mirror",
    equalizer: "clarity",
    note: {
      zh: "为盲人和低视力用户：只靠语音，用钟点方向描述位置，先说安全信息，不猜测；高对比大字界面。",
      en: "For blind and low-vision wearers: everything spoken, positions as clock directions, safety first, no guessing. High-contrast look."
    }
  },
  {
    id: "ar-headset",
    family: "glasses",
    label: { zh: "AR 眼镜", en: "AR glasses" },
    template: "holo",
    visualizer: "dots",
    equalizer: "open-ear",
    note: {
      zh: "只说画面上没有的内容，不重复显示的信息。",
      en: "Speaks only what the display does not already show."
    }
  },
  {
    id: "vr-headset",
    family: "other",
    label: { zh: "VR 头显", en: "VR headset" },
    template: "holo",
    visualizer: "ring",
    equalizer: "flat",
    note: {
      zh: "提醒你看不到真实房间，建议走动前先注意周围空间。",
      en: "Remembers you cannot see the room, and says so before suggesting you move."
    }
  },
  {
    id: "wearable",
    family: "other",
    label: { zh: "其他可穿戴设备", en: "Any wearable" },
    template: "visor",
    visualizer: "wave",
    equalizer: "flat",
    note: {
      zh: "通用设置，适合以上都不是的设备。",
      en: "General defaults for anything not listed above."
    }
  },
  {
    id: "app",
    family: "other",
    label: { zh: "网站或应用", en: "Website or app" },
    template: "daylight",
    visualizer: "ring",
    equalizer: "flat",
    note: {
      zh: "放进你自己的产品：不需要唤醒词，能力来自你接入的工具。",
      en: "A voice agent inside your own product: no wake word, and it can do what your tools let it do."
    }
  }
];

export const DEFAULT_DEVICE_ID = "motorcycle-helmet";

export function findDevice(id: string | undefined): DeviceInfo {
  return DEVICES.find((device) => device.id === id) ?? DEVICES.find((device) => device.id === DEFAULT_DEVICE_ID)!;
}

// The device marks. These are copies of brand/devices/*.svg (the relay owns
// /brand/ on the same origin, so the originals cannot be served from there
// in development); tests/landing-routing.test.ts keeps them identical.
const LOGO_FILES = import.meta.glob<string>("../assets/device-marks/*.svg", {
  eager: true,
  query: "?url",
  import: "default"
});

/** URL of a device's built-in mark. */
export function deviceLogoUrl(id: string): string | undefined {
  return LOGO_FILES[`../assets/device-marks/${id}.svg`] ?? LOGO_FILES["../assets/device-marks/wearable.svg"];
}

export type BackendInfo = {
  id: string;
  label: string;
  /** Where it runs. */
  place: "demo" | "cloud" | "local";
  description: Bilingual;
  /** .env lines it needs, with values left blank for the owner to fill in. */
  env: readonly string[];
};

export const BACKENDS: readonly BackendInfo[] = [
  {
    id: "mock",
    label: "Demo",
    place: "demo",
    description: {
      zh: "脚本对话，不需要账号或密钥。用于先把设备跑通。",
      en: "A scripted conversation, no account or key. For getting the device working first."
    },
    env: []
  },
  {
    id: "doubao",
    label: "Doubao Realtime",
    place: "cloud",
    description: { zh: "字节跳动豆包实时语音，中文最强。", en: "ByteDance Doubao live voice. Strongest in Chinese." },
    env: ["DOUBAO_API_KEY="]
  },
  {
    id: "openai",
    label: "OpenAI Realtime",
    place: "cloud",
    description: { zh: "OpenAI 实时语音到语音。", en: "OpenAI live speech-to-speech." },
    env: ["OPENAI_API_KEY="]
  },
  {
    id: "grok",
    label: "Grok Voice",
    place: "cloud",
    description: { zh: "xAI Grok 实时语音。", en: "xAI Grok live voice." },
    env: ["XAI_API_KEY="]
  },
  {
    id: "gemini",
    label: "Gemini Live",
    place: "cloud",
    description: { zh: "Google Gemini 实时语音。", en: "Google Gemini live voice." },
    env: ["GEMINI_API_KEY="]
  },
  {
    id: "pipeline",
    label: "Whisper pipeline",
    place: "cloud",
    description: {
      zh: "语音转文字、任意对话模型、文字转语音三段串联。可指向云端，也可指向本地服务。",
      en: "Speech-to-text, any chat model, text-to-speech in a chain. Point it at a cloud service or at your own."
    },
    env: ["PIPELINE_API_KEY=", "PIPELINE_BASE_URL="]
  },
  {
    id: "local",
    label: "Local models",
    place: "local",
    description: {
      zh: "开放权重模型跑在你自己的硬件上：Whisper 类语音识别、Ollama / llama.cpp / vLLM 对话模型、Kokoro / Piper 类语音合成。可完全离线。",
      en: "Open-weight models on your own hardware: Whisper-class speech-to-text, an Ollama, llama.cpp or vLLM chat model, Kokoro or Piper-class speech. Can run fully offline."
    },
    env: ["LOCAL_VOICE=on"]
  },
  {
    id: "local-realtime",
    label: "Local realtime",
    place: "local",
    description: {
      zh: "你自己部署的、兼容 OpenAI Realtime 协议的服务。",
      en: "A server you host that speaks the OpenAI Realtime protocol."
    },
    env: ["LOCAL_REALTIME_URL="]
  }
];

export function findBackend(id: string | undefined): BackendInfo {
  return BACKENDS.find((backend) => backend.id === id) ?? BACKENDS[0]!;
}

/** Languages the relay can name in its persona prompt. */
export const LANGUAGES: ReadonlyArray<{ code: string; label: Bilingual }> = [
  { code: "zh", label: { zh: "中文", en: "Chinese" } },
  { code: "en", label: { zh: "英语", en: "English" } },
  { code: "ja", label: { zh: "日语", en: "Japanese" } },
  { code: "ko", label: { zh: "韩语", en: "Korean" } },
  { code: "es", label: { zh: "西班牙语", en: "Spanish" } },
  { code: "fr", label: { zh: "法语", en: "French" } },
  { code: "de", label: { zh: "德语", en: "German" } },
  { code: "pt", label: { zh: "葡萄牙语", en: "Portuguese" } },
  { code: "it", label: { zh: "意大利语", en: "Italian" } },
  { code: "ru", label: { zh: "俄语", en: "Russian" } },
  { code: "ar", label: { zh: "阿拉伯语", en: "Arabic" } },
  { code: "hi", label: { zh: "印地语", en: "Hindi" } },
  { code: "tr", label: { zh: "土耳其语", en: "Turkish" } },
  { code: "tg", label: { zh: "塔吉克语", en: "Tajik" } }
];

const preset = (id: string, label: string, description: string, bands: number[], preamp = 0) => ({
  id,
  label,
  description,
  bands,
  preamp
});

/** The relay's equaliser offer, for when there is no relay to ask. */
export const BUILT_IN_EQUALIZER: VoiceEqualizerOptions = {
  default: { preset: "flat" },
  adjustable: true,
  frequencies: [...EQUALIZER_FREQUENCIES],
  presets: [
    preset("flat", "Flat", "The voice as the backend produced it.", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    preset("clarity", "Clarity", "Lifts consonants so speech is easier to follow.", [-3, -2, -1, 0, 0, 2, 4, 4, 2, 1]),
    preset(
      "wind",
      "Helmet · wind",
      "Cuts the lows that wind and engine noise mask and pushes the speech band through.",
      [-12, -10, -6, -2, 0, 3, 5, 5, 3, 1],
      2
    ),
    preset(
      "open-ear",
      "Open-ear glasses",
      "Adds the body that small open speakers lose.",
      [4, 6, 5, 3, 1, 1, 2, 2, 0, 0]
    ),
    preset("outdoor", "Outdoor", "Forward and loud, for streets and trails.", [-6, -4, -2, 0, 1, 3, 4, 4, 2, 0], 3),
    preset(
      "warm",
      "Warm",
      "Softer and rounder, for quiet rooms and long listening.",
      [2, 3, 3, 2, 0, -1, -1, -2, -3, -4]
    ),
    preset(
      "quiet",
      "Quiet",
      "Lower and gentler, so people nearby are not disturbed.",
      [-2, -1, 0, 0, 0, 1, 1, 0, -2, -3],
      -5
    ),
    preset(
      "night",
      "Night",
      "Smooth and low, with the sharp edges taken off.",
      [-4, -2, 0, 1, 0, -1, -2, -3, -5, -6],
      -3
    ),
    preset("loud", "Loud", "Fuller lows and highs with more level.", [5, 4, 2, 0, -1, 0, 2, 3, 4, 4], 2),
    preset("bass-boost", "Bass boost", "More weight in the low end.", [7, 6, 4, 2, 0, 0, 0, 0, 0, 0]),
    preset("treble-boost", "Treble boost", "Brighter, with more air.", [0, 0, 0, 0, 0, 1, 2, 4, 6, 7]),
    preset("vocal", "Vocal", "The mid-range forward, like a broadcast voice.", [-4, -3, -1, 2, 4, 4, 3, 2, 0, -1]),
    preset("radio", "Radio", "A small-speaker radio voice.", [-10, -7, -2, 2, 4, 4, 2, -1, -5, -9]),
    preset("telephone", "Telephone", "Narrow, like a phone line.", [-12, -12, -6, 1, 4, 4, 1, -8, -12, -12]),
    preset("soft", "Soft", "Gentle highs for sensitive ears.", [1, 1, 1, 0, 0, -1, -2, -3, -4, -5], -1)
  ]
};
