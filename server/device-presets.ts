import type { AssistantDevice } from "../shared/agent";

/**
 * The embodied devices the framework knows how to speak for.
 *
 * A preset is the part of the persona that depends on where the assistant
 * lives: what the device and its wearer are called, what the assistant is
 * mostly asked to do there, and the one or two behaviours that matter on that
 * device and nowhere else (an assistant for a blind wearer must never say
 * "as you can see"; one inside a VR headset must remember the wearer cannot
 * see the room). `family` is the coarse grouping older clients understand.
 *
 * Adding a device is adding an entry here — nothing else needs to change.
 */
export type DevicePreset = {
  id: string;
  family: AssistantDevice;
  label: { zh: string; en: string };
  wearer: { zh: string; en: string };
  /** What the assistant mainly helps with on this device. One sentence. */
  scope: { zh: string; en: string };
  /** Device-specific conduct, appended after the scope. May be empty. */
  conduct: { zh: string; en: string };
  /** Equaliser preset that suits the device's speakers and surroundings. */
  equalizer: string;
  /** Design template that suits how the companion app is used with it. */
  template: string;
};

export const DEVICE_PRESETS: readonly DevicePreset[] = [
  {
    id: "motorcycle-helmet",
    family: "helmet",
    label: { zh: "摩托车头盔", en: "motorcycle helmet" },
    wearer: { zh: "骑手", en: "rider" },
    scope: {
      zh: "帮助骑手处理导航、天气、路况、附近停靠点和骑行安全事项。",
      en: "Help the rider with navigation, weather, road conditions, nearby stops and riding safety. "
    },
    conduct: { zh: "", en: "" },
    equalizer: "wind",
    template: "visor"
  },
  {
    id: "bicycle-helmet",
    family: "helmet",
    label: { zh: "自行车头盔", en: "bicycle helmet" },
    wearer: { zh: "骑行者", en: "cyclist" },
    scope: {
      zh: "帮助骑行者处理路线、车流、天气、补给点和骑行节奏。",
      en: "Help the cyclist with routes, traffic, weather, places to stop and pacing. "
    },
    conduct: {
      zh: "骑行者需要听到周围的车流：回答比平时更短，对方用力或爬坡时不要主动闲聊。",
      en: "A cyclist needs to hear traffic: keep answers even shorter than usual and do not volunteer small talk while they are working hard. "
    },
    equalizer: "wind",
    template: "daylight"
  },
  {
    id: "sunglasses",
    family: "glasses",
    label: { zh: "智能太阳镜", en: "smart sunglasses" },
    wearer: { zh: "用户", en: "wearer" },
    scope: {
      zh: "帮助用户处理眼前的事情：导航、天气、提醒、看到的东西，以及随口的问题。",
      en: "Help the wearer with what is in front of them: directions, weather, reminders, what they are looking at, and quick questions. "
    },
    conduct: {
      zh: "扬声器是开放式的，旁人可能听见：涉及隐私的内容先问是否现在念出来。",
      en: "The speakers are open-ear and others may overhear: before reading out anything private, ask whether to say it now. "
    },
    equalizer: "open-ear",
    template: "daylight"
  },
  {
    id: "smart-glasses",
    family: "glasses",
    label: { zh: "智能眼镜", en: "smart glasses" },
    wearer: { zh: "用户", en: "wearer" },
    scope: {
      zh: "帮助用户处理眼前的事情：导航、天气、提醒、看到的东西，以及随口的问题。",
      en: "Help the wearer with what is in front of them: directions, weather, reminders, what they are looking at, and quick questions. "
    },
    conduct: {
      zh: "扬声器是开放式的，旁人可能听见：涉及隐私的内容先问是否现在念出来。",
      en: "The speakers are open-ear and others may overhear: before reading out anything private, ask whether to say it now. "
    },
    equalizer: "open-ear",
    template: "visor"
  },
  {
    id: "assistive-glasses",
    family: "glasses",
    label: { zh: "助视眼镜", en: "assistive glasses" },
    wearer: { zh: "用户", en: "wearer" },
    scope: {
      zh: "用户是盲人或低视力人士。帮助对方了解周围环境、读出文字、辨认物品和人，以及安全出行。",
      en: "The wearer is blind or has low vision. Help them understand their surroundings, read text aloud, identify objects and people, and get around safely. "
    },
    conduct: {
      zh:
        "一切只靠语音：不要说“如你所见”，不要让对方看屏幕。描述位置时用钟点方向和大致距离（例如“两点钟方向，约三米”）。" +
        "先说对安全最重要的信息，例如台阶、车辆、障碍物。看不清或不确定时直接说不确定，绝不猜测。读文字时逐字读出，不要概括，除非对方要求。",
      en:
        'Everything is spoken: never say "as you can see" and never send them to a screen. Give positions as clock directions with a rough distance ("two o\'clock, about three metres"). ' +
        "Say what matters for safety first — steps, vehicles, obstacles. When you cannot see something clearly, say so; never guess. Read text out word for word unless they ask for a summary. "
    },
    equalizer: "clarity",
    template: "beacon"
  },
  {
    id: "ar-headset",
    family: "glasses",
    label: { zh: "AR 眼镜", en: "AR glasses" },
    wearer: { zh: "用户", en: "wearer" },
    scope: {
      zh: "帮助用户处理眼前的任务：指引、识别看到的东西、查询信息和免手操作。",
      en: "Help the wearer with the task in front of them: guidance, recognising what they are looking at, looking things up and hands-free control. "
    },
    conduct: {
      zh: "用户的视野里已经有画面：语音只补充画面没有的信息，不要重复念出显示的内容。",
      en: "The wearer already has a display in view: speak only what the display does not show, and do not read back what is on it. "
    },
    equalizer: "open-ear",
    template: "holo"
  },
  {
    id: "vr-headset",
    family: "other",
    label: { zh: "VR 头显", en: "VR headset" },
    wearer: { zh: "用户", en: "wearer" },
    scope: {
      zh: "帮助用户在虚拟体验中获得指引、查询信息和免手操作。",
      en: "Help the wearer inside a virtual experience with guidance, looking things up and hands-free control. "
    },
    conduct: {
      zh: "用户看不到真实房间：涉及走动或大幅度动作的建议，先提醒注意周围空间。",
      en: "The wearer cannot see the real room: before suggesting they move or reach, remind them to mind the space around them. "
    },
    equalizer: "flat",
    template: "holo"
  },
  {
    id: "wearable",
    family: "other",
    label: { zh: "可穿戴设备", en: "wearable" },
    wearer: { zh: "用户", en: "wearer" },
    scope: {
      zh: "帮助用户处理眼前的事情：导航、天气、提醒、看到的东西，以及随口的问题。",
      en: "Help the wearer with what is in front of them: directions, weather, reminders, what they are looking at, and quick questions. "
    },
    conduct: { zh: "", en: "" },
    equalizer: "flat",
    template: "visor"
  }
];

/** The preset each coarse family means when a config only names the family. */
const FAMILY_DEFAULT: Record<AssistantDevice, string> = {
  helmet: "motorcycle-helmet",
  glasses: "smart-glasses",
  other: "wearable"
};

const ALIASES: Record<string, string> = {
  motorcycle: "motorcycle-helmet",
  moto: "motorcycle-helmet",
  bicycle: "bicycle-helmet",
  bike: "bicycle-helmet",
  "bike-helmet": "bicycle-helmet",
  "smart-sunglasses": "sunglasses",
  assistive: "assistive-glasses",
  "low-vision": "assistive-glasses",
  "visually-impaired": "assistive-glasses",
  ar: "ar-headset",
  "ar-glasses": "ar-headset",
  vr: "vr-headset",
  xr: "vr-headset"
};

/** Resolves a configured `device` — a preset id, an alias, or a family — to
 *  its preset. Unknown or missing values mean the original motorcycle helmet. */
export function devicePreset(value: unknown): DevicePreset {
  const key =
    typeof value === "string"
      ? value
          .trim()
          .toLowerCase()
          .replace(/[\s_]+/g, "-")
      : "";
  const id = FAMILY_DEFAULT[key as AssistantDevice] ?? ALIASES[key] ?? key;
  return DEVICE_PRESETS.find((preset) => preset.id === id) ?? DEVICE_PRESETS[0]!;
}

/** True when `value` names a device the framework knows. */
export function isKnownDevice(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  const key = value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  return key in FAMILY_DEFAULT || key in ALIASES || DEVICE_PRESETS.some((preset) => preset.id === key);
}
