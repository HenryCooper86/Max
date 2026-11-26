/**
 * Turns a final rider utterance into a device command. Pure and dependency-free
 * so the whole grammar is table-testable, and so a Doubao function-calling
 * extractor can replace it later behind `IntentExtractor` without touching the
 * relay, the protocol, or any client.
 *
 * Import direction is load-bearing: every device-action type originates here and
 * flows outward. `shared/agent.ts` imports from this file, never the reverse.
 */

import { randomUUID } from "node:crypto";

export type DeviceActionName =
  | "torch.set"
  | "volume.set"
  | "music.control"
  | "sms.compose"
  | "call.dial"
  | "destination.show"
  | "camera.photo"
  | "camera.record"
  | "camera.look"
  | "gallery.open"
  | "gallery.describe"
  | "vision.watch"
  | "navigation.start"
  | "navigation.stop"
  | "system.shutdown";

export type DeviceActionTier = "low" | "high";

export type DeviceActionStatus = "ok" | "failed" | "denied" | "unsupported";

/** Not exported: no consumer names this type today — they go through
 *  `IntentExtractor`. Export it when a second extractor needs it. */
type DeviceCommand =
  | { action: "torch.set"; args: { on: boolean } }
  | { action: "volume.set"; args: { direction: "up" | "down" } }
  | { action: "music.control"; args: { control: "play" | "pause" | "next" | "previous"; app?: string } }
  | { action: "sms.compose"; args: { name: string; body: string } }
  | { action: "call.dial"; args: { name?: string; number?: string } }
  | { action: "destination.show"; args: { query: string } }
  | { action: "camera.photo"; args: Record<string, never> }
  | { action: "camera.record"; args: { start: boolean } }
  | { action: "camera.look"; args: { question?: string } }
  | { action: "gallery.open"; args: Record<string, never> }
  | { action: "gallery.describe"; args: { kind: "photo" | "video" | "latest"; question?: string } }
  | { action: "vision.watch"; args: { on: boolean } }
  | { action: "navigation.start"; args: { query: string } }
  | { action: "navigation.stop"; args: Record<string, never> }
  | { action: "system.shutdown"; args: { cancel?: boolean } };

/** Declared risk. iOS satisfies the high tier with the native system
 *  confirmation that `tel:` and MFMessageComposeViewController already force;
 *  the field exists for the camera (Spec 2) and for Android. */
export const DEVICE_ACTION_TIERS: Record<DeviceActionName, DeviceActionTier> = {
  "torch.set": "low",
  "volume.set": "low",
  "music.control": "low",
  "sms.compose": "high",
  "call.dial": "high",
  "destination.show": "low",
  "camera.photo": "low",
  "camera.record": "low",
  "camera.look": "low",
  "gallery.open": "low",
  "gallery.describe": "low",
  "vision.watch": "low",
  "navigation.start": "low",
  "navigation.stop": "low",
  // High like dialing: consequential, and satisfied on the board by the 10 s
  // cancellable countdown the way iOS satisfies it with native confirms.
  "system.shutdown": "high"
};

export type IntentExtractor = (text: string) => DeviceCommand | null;

/**
 * Actions whose detection is restricted to certain client platforms, each one
 * listed by the platform string the session reports at `session.start`.
 *
 * `camera.look` is the first entry: it requires the relay to dispatch a
 * `device.command` that fetches a live frame, and only the embedded board's
 * dispatcher implements that action (`rdk/agent/src/device/dispatch.ts`). The
 * current iOS and Android apps answer an action they have no handler for with
 * `unsupported` (`action.unknown`) at once, but an older app build drops it,
 * and the rider then sits through the full `DEVICE_RESULT_TIMEOUT_MS` in
 * silence before a generic timeout line, instead of getting an ordinary spoken
 * answer from the model. Every other `DeviceActionName` already has a real
 * handler on every platform it is dispatched to, so it is absent from this map
 * and detected everywhere, as before.
 */
const PLATFORM_RESTRICTED_ACTIONS: Partial<Record<DeviceActionName, readonly string[]>> = {
  "camera.look": ["embedded"],
  // Phones cannot poweroff, and an older app build receiving an unknown
  // action would sit out the result timeout in silence.
  "system.shutdown": ["embedded"],
  // Describing a capture uploads it from the rider's photo library, which only
  // the phones have: both apps decode the command and answer with
  // `vision.frames` (Android: the "gallery.describe" branch of DeviceActions.kt).
  // The board has no library (EMBEDDED_CAPABILITIES refuses it) and a web
  // session has no handler at all.
  "gallery.describe": ["ios", "android"],
  // Proactive scene watching (V-C) drives the embedded board's own camera
  // loop; a phone has no such loop to toggle.
  "vision.watch": ["embedded"]
};

/**
 * extractDeviceCommand, plus the platform gate above. The extractor itself
 * stays pure and platform-agnostic (session/platform state does not exist at
 * that layer, and its existing tests assert detection with no platform in
 * scope at all) — this wrapper is what a caller that actually dispatches a
 * command to a live client (server/providers/doubao.ts,
 * server/providers/mock.ts) should call instead, so the phrase falls through
 * to ordinary conversation on any client that cannot act on it.
 *
 * The gate lives here, in one place keyed off the action, rather than as an
 * ad hoc platform check duplicated at each dispatch call site — the same
 * lesson server/hazard-injector.ts already draws from this codebase's history
 * of a platform allowlist copied across files that silently rejected the
 * embedded board once it existed.
 */
export function extractDeviceCommandForPlatform(text: string, platform: string | undefined): DeviceCommand | null {
  const command = extractDeviceCommand(text);
  if (!command) return null;
  const allowedPlatforms = PLATFORM_RESTRICTED_ACTIONS[command.action];
  if (allowedPlatforms && !allowedPlatforms.includes(platform ?? "")) return null;
  return command;
}

export type DeviceActivityIntent = {
  target: "recording" | "navigation";
  active: boolean;
};

const CONTEXTUAL_CANCEL_ZH =
  /^(?:(?:max|马克斯|麦克斯)[\s,，]*)?(?:(?:那?好(?:的)?|嗯|行|可以)[\s,，]*)*(?:请|麻烦)?(?:帮我)?(?:取消|停(?:止|一下)?|关掉|关闭)(?:它|这个|一下)?$/i;
const CONTEXTUAL_CANCEL_EN =
  /^(?:max[\s,]*)?(?:(?:okay|ok|sure)[\s,]*)?(?:please\s+)?(?:cancel(?:\s+(?:it|that))?|stop(?:\s+(?:it|that))?|turn\s+(?:it|that)\s+off)(?:\s+please)?$/i;

/**
 * Resolves short follow-ups such as “帮我取消” against device state that the
 * relay learned from real device results. A bare cancel with no active target
 * remains ordinary conversation; guessing a start/stop target would be worse
 * than asking the rider to name it.
 *
 * A start is considered a candidate as soon as it is dispatched so an
 * immediate cancel can still stop hardware whose success response is delayed
 * or lost. Failure reconciliation removes that candidate, except for the
 * honest “already recording” result, which proves the target is active.
 */
export class DeviceActivityContext {
  private readonly active: Record<DeviceActivityIntent["target"], boolean> = {
    recording: false,
    navigation: false
  };
  private recent: DeviceActivityIntent["target"][] = [];

  commandFor(text: string, platform: string | undefined): DeviceCommand | null {
    const direct = extractDeviceCommandForPlatform(text, platform);
    if (direct) return direct;

    const normalized = text.trim().replace(/[。！!？?]+$/g, "");
    if (!CONTEXTUAL_CANCEL_ZH.test(normalized) && !CONTEXTUAL_CANCEL_EN.test(normalized)) return null;

    const target = [...this.recent].reverse().find((candidate) => this.active[candidate]);
    if (target === "recording") return { action: "camera.record", args: { start: false } };
    if (target === "navigation") return { action: "navigation.stop", args: {} };
    return null;
  }

  track(command: DeviceCommand): DeviceActivityIntent | undefined {
    const intent: DeviceActivityIntent | undefined =
      command.action === "camera.record"
        ? { target: "recording", active: command.args.start }
        : command.action === "navigation.start"
          ? { target: "navigation", active: true }
          : command.action === "navigation.stop"
            ? { target: "navigation", active: false }
            : undefined;
    if (!intent) return undefined;

    this.touch(intent.target);
    if (intent.active) this.active[intent.target] = true;
    return intent;
  }

  reconcile(intent: DeviceActivityIntent | undefined, result: { status: DeviceActionStatus; reason?: string }): void {
    if (!intent) return;
    if (result.status === "ok") {
      this.setActive(intent.target, intent.active);
      return;
    }

    if (intent.active) {
      const provenActive = intent.target === "recording" && result.reason === "camera.recording";
      this.setActive(intent.target, provenActive);
      return;
    }

    if (result.reason === "camera.notRecording" || result.reason === "navigation.notActive") {
      this.setActive(intent.target, false);
    }
  }

  private touch(target: DeviceActivityIntent["target"]): void {
    this.recent = [...this.recent.filter((candidate) => candidate !== target), target];
  }

  private setActive(target: DeviceActivityIntent["target"], active: boolean): void {
    this.active[target] = active;
    if (active) this.touch(target);
    else this.recent = this.recent.filter((candidate) => candidate !== target);
  }
}

/** Preserve explicitly named players so each client can route or refuse honestly. */
const THIRD_PARTY_PLAYERS: Array<[RegExp, string]> = [
  [/网易云(音乐)?/, "网易云音乐"],
  [/qq\s*(音乐|music)/i, "QQ音乐"],
  [/酷狗/, "酷狗音乐"],
  [/酷我/, "酷我音乐"],
  [/spotify/i, "Spotify"]
];

/** Rider said "don't" / "别" / "不用". Any command match is discarded. */
const NEGATION = /(别|不要|不用|不想|没必要|don'?t|do not|no need)/i;

const EMERGENCY_NUMBERS: Array<[RegExp, string]> = [
  [/(报警|叫警察|call the police)/i, "110"],
  [/(救护车|急救|ambulance)/i, "120"],
  [/(交警|事故报警|traffic police)/i, "122"]
];

function clean(value: string): string {
  return value.trim().replace(/^[，,。.、!！?？\s]+|[，,。.、!！?？\s]+$/g, "");
}

export const extractDeviceCommand: IntentExtractor = (text) => {
  const raw = text.trim();
  if (!raw) return null;

  // Checked before the negation discard, as a documented exception: a negated
  // 关机 ("别关机", "不要关机") is the rider cancelling a countdown — a
  // command, not noise. Everything else negated stays discarded below.
  if (
    /(取消|别|不要|不用).{0,3}关机/.test(raw) ||
    /(cancel|don'?t|do not|stop)\s*(the\s+)?(shut\s?down|shutdown|power\s?off)/i.test(raw)
  ) {
    return { action: "system.shutdown", args: { cancel: true } };
  }

  // The same exception for a negated 录: "别录了" is the rider ending a
  // recording, not noise. Restricted to 录-forms — "别拍视频" stays discarded
  // because 拍 belongs to the photo grammar. 录 must be followed by an object
  // or a particle so prose like "不录音质" cannot match on the bare verb.
  if (/(别|不要|不用|不想|不)(再|继续)?录(像|制|影|个?视频|了|啦)/.test(raw)) {
    return { action: "camera.record", args: { start: false } };
  }

  if (NEGATION.test(raw)) return null;

  // Emergency first: "报警" must never be read as a contact named 警.
  for (const [pattern, number] of EMERGENCY_NUMBERS) {
    if (pattern.test(raw)) return { action: "call.dial", args: { number } };
  }

  // Chinese and English are kept as separate patterns: a single combined one
  // would need a gap wide enough for "turn on *the* flashlight", and that same
  // gap makes the Chinese side over-match ("开车的时候灯光暗").
  if (
    /(打开|开启|开|亮起).{0,4}(手电筒|手电|照明|灯光|灯)/.test(raw) ||
    /(turn|switch|put)\s+on\s+(the\s+)?(flash\s?light|torch)/i.test(raw)
  ) {
    return { action: "torch.set", args: { on: true } };
  }
  if (
    /(关闭|关掉|关|熄灭).{0,4}(手电筒|手电|照明|灯光|灯)/.test(raw) ||
    /(turn|switch|put|power)\s+off\s+(the\s+)?(flash\s?light|torch)/i.test(raw)
  ) {
    return { action: "torch.set", args: { on: false } };
  }

  if (/(大声|响一点|声音.{0,2}大|调大|louder|speak up|volume up)/i.test(raw)) {
    return { action: "volume.set", args: { direction: "up" } };
  }
  if (/(小声|轻一点|声音.{0,2}小|调小|quieter|softer|volume down)/i.test(raw)) {
    return { action: "volume.set", args: { direction: "down" } };
  }

  // vision.watch (V-C): toggles the embedded board's proactive scene-watching
  // loop. 环境观察 collides with nothing else in this grammar, so it needs no
  // particular ordering relative to the other toggles above or below it.
  if (/(打开|开启).{0,4}环境观察/.test(raw) || /(start|begin)\s+(the\s+)?(scene\s+)?watching/i.test(raw)) {
    return { action: "vision.watch", args: { on: true } };
  }
  if (/(关闭|关掉|停止|取消)(一下)?环境观察/.test(raw) || /stop\s+watching/i.test(raw)) {
    return { action: "vision.watch", args: { on: false } };
  }

  // 关机 must not be preceded by 手/机 — "我手机关机了" is about the rider's
  // phone. English must not capture a device noun the torch/music grammars
  // own ("power off the flashlight").
  if (
    /(?<![手机])关机/.test(raw) ||
    /(shut\s?down|power\s?off)(?!\s*(the\s+)?(flash\s?light|torch|light|lights|lamp|music|song|camera|screen|phone))/i.test(
      raw
    )
  ) {
    return { action: "system.shutdown", args: {} };
  }

  // matchGalleryDescribe must run before matchCamera because the 拍-verbs
  // (拍照、拍视频) would otherwise collide with camera.photo, and 看看 with
  // the vision branches of camera.look. The gallery grammar requires explicit
  // recency markers (我刚拍的、刚才录的) to distinguish describe from taking a photo.
  const gallery = matchGalleryDescribe(raw);
  if (gallery) return gallery;

  const camera = matchCamera(raw);
  if (camera) return camera;

  const music = matchMusic(raw);
  if (music) return music;

  const sms = matchSms(raw);
  if (sms) return sms;

  const navigation = matchNavigation(raw);
  if (navigation) return navigation;

  const call = matchCall(raw);
  if (call) return call;

  return null;
};

const GALLERY_REF = /(我|刚|刚才).{0,4}(拍|录)的/;
const GALLERY_ACTION = /(看看|描述|讲讲)|\b(describe|show( me)?|look at|check)\b/i;
const GALLERY_QUESTION = /(是什么|什么样|写的什么|写着什么|有什么|有没有)/;

/** Truncate a string to at most maxBytes, cutting on a character boundary
 *  (never mid-codepoint). The wire's 500-byte cap on vision.frames.question
 *  would otherwise reject every chunk that echoes an over-long question — truncating
 *  here keeps the relay from breaking a contract with itself, and the model still
 *  sees the leading 500 bytes of the ask. */
function truncateToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let result = "";
  for (const char of text) {
    if (Buffer.byteLength(result + char) > maxBytes) break;
    result += char;
  }
  return result;
}

function matchGalleryDescribe(raw: string): DeviceCommand | null {
  if (!GALLERY_REF.test(raw) && !/\b(photo|picture|video) (i|we) (just )?(took|recorded|shot)\b/i.test(raw))
    return null;
  // A gallery reference alone is not enough — the utterance must also carry a describe-verb
  // (either language) or a content question, which keeps delete/send/navigate phrasings out.
  if (!GALLERY_ACTION.test(raw) && !GALLERY_QUESTION.test(raw) && !/\bwhat('s| is)\b/i.test(raw)) return null;
  const kind = /(视频|录像|影片|video)/i.test(raw)
    ? ("video" as const)
    : /(照片|相片|photo|picture)/i.test(raw)
      ? ("photo" as const)
      : ("latest" as const);
  const question = GALLERY_QUESTION.test(raw) || /\bwhat('s| is)\b/i.test(raw) ? truncateToBytes(raw, 500) : undefined;
  return { action: "gallery.describe", args: question ? { kind, question } : { kind } };
}

function matchCamera(raw: string): DeviceCommand | null {
  // Stop is checked before start so "停止录像" is never read as "录像", and its
  // grammar is deliberately more generous than start's: an over-matched stop
  // fails honestly as "现在没有在录像", while an under-matched one leaves the
  // camera rolling behind a narrated save that never happened — live sessions
  // said "帮我停一下录视频" and "停止我们的拍视频", fell through to a
  // start grammar, and got a confirmation plus that fiction. (?!车) keeps 停车
  // (parking) from reading as a stop verb; the gap covers filler like 一下 /
  // 刚才的 / 我们的. 录音 is accepted on stop because this product has no
  // audio-only recorder, while Doubao ASR commonly substitutes it for 录像.
  if (
    /(停止|结束|暂停|关闭|关掉|停一下|停下|停)(?!车).{0,3}(录像|录制|录影|录音|摄像|拍视频|视频|拍摄)/.test(raw) ||
    /(stop|end|finish|pause)\s+(the\s+|this\s+)?(video|recording|filming|record)/i.test(raw)
  ) {
    return { action: "camera.record", args: { start: false } };
  }
  // 拍-phrasings need an explicit 视频 object (bare 拍摄 needs 开始): a rider
  // said "帮我拍视频" on a live session, matched nothing here, and the model
  // narrated a recording that never happened — countdown, "已保存到相册", all
  // fiction. 拍 without 视频 must keep falling through to camera.photo.
  if (
    /(开始)?(录像|录制|录影|录个?视频|录一段|拍摄?一?(个|段|条)?视频)/.test(raw) ||
    /开始.{0,2}拍摄/.test(raw) ||
    /(start\s+recording|(record|shoot|film|take)\s+(a\s+)?video)/i.test(raw)
  ) {
    return { action: "camera.record", args: { start: true } };
  }
  // matchCamera runs before matchNavigation. The vision question pattern is
  // greedy and can catch navigation-intent phrases whose destination sits near a
  // question word (e.g., "导航去前面那个什么样的加油站" would match the 前面/什么样
  // part and hijack into camera.look). Exclude navigation verbs first so the
  // phrase falls through to matchNavigation later.
  const navigationIntent = /(导航|带我去|怎么走)/.test(raw);

  // Specific-question branch runs before generic so a phrase matching both
  // (e.g., "前面是什么") carries its question for the vision model.
  const visionQuestionPattern =
    /(前面|前方).{0,8}(是什么|什么样|写的什么|写着什么)|(路牌|标志|招牌|牌子).{0,6}(写的什么|写着什么|是什么)/;
  if (!navigationIntent && (visionQuestionPattern.test(raw) || /what('s| is)\s+(that|ahead)/i.test(raw))) {
    return { action: "camera.look", args: { question: raw } };
  }
  if (
    !navigationIntent &&
    (/(你能?看到?什么|看看前面|看一下前面)/.test(raw) || /what\s+(do|can)\s+you\s+see/i.test(raw))
  ) {
    return { action: "camera.look", args: {} };
  }
  if (/(拍照|拍个?照|拍张?照片?|照相)/.test(raw) || /take\s+a\s+(photo|picture|pic)/i.test(raw)) {
    return { action: "camera.photo", args: {} };
  }
  if (/(打开|查看|看看).{0,3}(相册|图库|照片墙)/.test(raw) || /(open|show)\s+(the\s+)?(gallery|album)/i.test(raw)) {
    return { action: "gallery.open", args: {} };
  }
  return null;
}

function matchMusic(raw: string): DeviceCommand | null {
  let control: "play" | "pause" | "next" | "previous" | undefined;
  if (
    /(下一首|下一曲|换一?首(?:歌)?|切歌|next\s+(track|song)|\b(?:next|skip)(?:\s+(?:to\s+)?next)?\s+(?:on\s+|in\s+)?qq\s*(音乐|music))/i.test(
      raw
    ) ||
    /\bskip\s+(?:to\s+)?(?:the\s+)?next(?:\s+(?:one|please))?[.!?。！？，,\s]*$/i.test(raw) ||
    /^(?:(?:max|麦克斯)[，,\s]*)?(?:please\s+)?(?:skip|next)(?:\s+(?:one|please))?[.!?。！？，,\s]*$/i.test(raw) ||
    /\bskip\s+(?:(?:to\s+)?(?:another|the\s+next|a\s+different)|this|that|the|current)\s+(song|track)\b/i.test(raw) ||
    /\b(?:play|put\s+on)\s+(?:another|a\s+different)\s+(song|track)\b/i.test(raw) ||
    /\bchange\s+(?:the|this|current)\s+(song|track)\b/i.test(raw)
  )
    control = "next";
  else if (/(上一首|上一曲|previous (track|song)|\bprevious\s+(?:on\s+|in\s+)?qq\s*(音乐|music))/i.test(raw))
    control = "previous";
  else if (
    /(暂停|停一下|停止|取消|关闭|\b(?:pause|stop|cancel|close)\b)/i.test(raw) &&
    /(音乐|歌|music|song|playback)/i.test(raw)
  )
    control = "pause";
  else if (
    /(放歌|播放音乐|放音乐|来点音乐|继续播放音乐|恢复播放|(?:播放|打开|继续播放|恢复播放)\s*qq\s*(音乐|music)|(?:play|resume|open)\s+qq\s*(music|音乐)|(?:play|resume) (?:some |the )?music)/i.test(
      raw
    )
  )
    control = "play";
  if (!control) return null;

  for (const [pattern, label] of THIRD_PARTY_PLAYERS) {
    if (pattern.test(raw)) return { action: "music.control", args: { control, app: label } };
  }
  return { action: "music.control", args: { control } };
}

function matchSms(raw: string): DeviceCommand | null {
  const zh =
    /给\s*(?<name>[^\s，,。]{1,12})\s*发(?:条|个)?\s*(?:短信|信息|消息)\s*(?:说|内容是|:|：)?\s*(?<body>.+)/.exec(raw);
  if (zh?.groups?.name && zh.groups.body) {
    return { action: "sms.compose", args: { name: clean(zh.groups.name), body: clean(zh.groups.body) } };
  }
  const en = /(?:text|message|send a (?:text|message) to)\s+(?<name>[^\s]+)\s+(?:saying|that)\s+(?<body>.+)/i.exec(raw);
  if (en?.groups?.name && en.groups.body) {
    return { action: "sms.compose", args: { name: clean(en.groups.name), body: clean(en.groups.body) } };
  }
  return null;
}

function matchNavigation(raw: string): DeviceCommand | null {
  // Stop is checked before start so "停止导航" is never read as a destination.
  if (/(停止|结束|取消|退出)\s*导航/.test(raw) || /stop\s+(the\s+)?navigation/i.test(raw)) {
    return { action: "navigation.stop", args: {} };
  }
  const zh = /(?:导航|带我|我要)\s*(?:去|到|回)\s*(?<query>.+)/.exec(raw);
  if (zh?.groups?.query) {
    const query = clean(zh.groups.query);
    if (query) return { action: "navigation.start", args: { query } };
  }
  const en = /(?:navigate|directions|take me|route)\s+to\s+(?<query>.+)/i.exec(raw);
  if (en?.groups?.query) {
    const query = clean(en.groups.query);
    if (query) return { action: "navigation.start", args: { query } };
  }
  return null;
}

/** Ordinary device-result deadline. Navigation gets longer below because route
 *  planning includes the phone/RDK handoff before the result returns. */
export const DEVICE_RESULT_TIMEOUT_MS = 8_000;
/** Includes a 30-second GPS acquisition, 7-second route lookup, and a
 *  60-second destination confirmation window, plus a transport margin. */
export const NAVIGATION_RESULT_TIMEOUT_MS = 105_000;

const FAILURE_SPEECH: Record<string, string> = {
  "permission.contacts": "我没有通讯录权限，去设置里开启后我再帮你拨号。",
  "permission.music": "我没有音乐库权限，去设置里开启后我再帮你播放。",
  "device.locked": "手机锁屏了，解锁后我再执行。",
  "unsafe.speed": "骑行中我不发短信，停车以后我再帮你发。",
  "player.unsupported": "当前平台不支持控制这个音乐应用，请使用音乐卡片中的可用来源或本机音乐。",
  "music.qq.integrationRequired": "请在 QQ 音乐中播放或切歌，当前平台尚未接入 QQ 音乐播放授权。",
  "music.emptyQueue": "还没有播放队列，请在应用里的音乐卡片上点选择音乐。",
  "music.unavailable": "音乐暂时无法播放，请检查音乐卡片中的提示和当前播放来源。",
  "music.busy": "音乐正在准备，请稍后重试。",
  "music.queueEnd": "已经到播放队列末尾了，请选择更多音乐。",
  "music.controlUnavailable": "当前音乐应用不支持这个播放操作。",
  "music.playerUnavailable": "没有找到这个音乐应用的播放队列，请先在该应用中选择音乐。",
  "permission.musicControl": "请先在音乐卡片上点控制音乐应用，按提示授权后再试。",
  "gallery.uploadFailed": "照片或视频上传失败，请检查连接后再试。",
  "action.invalid": "这个设备操作暂时不支持。",
  "action.unknown": "这个设备操作暂时不支持。",
  "device.unavailable": "设备暂时无法完成这个操作，请检查权限后再试。",
  "permission.device": "没有执行这个操作所需的设备权限，请在系统设置中检查。",
  // Shared by the phone's destination.show device action and the relay's own
  // nav.request handling (server/routing.ts) and the embedded navigation
  // controller's device.result reason — one reason code, one truthful line.
  "destination.notFound": "没找到这个地方。",
  "route.unavailable": "路线规划失败。",
  "contact.notFound": "通讯录里没找到这个人。",
  "torch.unavailable": "这台设备没有可用的手电筒。",
  "permission.camera": "我没有相机权限，去设置里开启后我再帮你拍。",
  "storage.full": "存储快满了，导出或删除一些内容后我再帮你拍。",
  // The phone sheds camera and other heavy work when it overheats or enters a
  // power-saving mode; the voice session and crash detection keep running.
  "device.hot": "手机过热，这个操作先暂停，语音和摔车检测照常。",
  "device.powerSave": "手机在省电模式，暂时不录像。",
  "camera.recording": "已经在录了。",
  "camera.notRecording": "现在没有在录像。",
  "shutdown.notPending": "现在没有要关机。",
  "capture.failed": "拍摄没成功。",
  "vision.sharingOff": "我现在不能看。",
  "navigation.notActive": "现在没有在导航。",
  "permission.location": "我没有定位权限，去设置里开启后我再帮你导航。",
  "gallery.empty": "相册里还没有照片或视频。",
  "gallery.unreadable": "这段内容我处理不了。",
  // Embedded (helmet) refusals. Worded generically because "device.noScreen"
  // serves both gallery.open and destination.show. Navigation gets its own code
  // rather than borrowing device.noPhone: audio-only turn-by-turn needs neither
  // a phone nor a screen, so either would be a false explanation.
  "device.noScreen": "头盔上没有屏幕，看不了。",
  "device.noPhone": "头盔上没有手机功能，这个我做不了。",
  "device.notYet": "这个功能头盔上还没上线。",
  // A navigation.start that never reaches a route (rider cancels mid-flight,
  // or a later stage supersedes it) reports this reason on its device.result
  // rather than the generic "导航操作没成功。".
  "navigation.cancelled": "已取消导航。",
  "location.unavailable": "手机定位未连接，请打开 Max 并开始头盔骑行。"
};

/** Spoken names for the fallback line, so a failure with no known reason still
 *  tells the rider *what* failed rather than "something". */
const ACTION_LABELS: Record<DeviceActionName, string> = {
  "torch.set": "手电筒",
  "volume.set": "音量",
  "music.control": "音乐",
  "sms.compose": "短信",
  "call.dial": "电话",
  "destination.show": "目的地",
  "camera.photo": "拍照",
  "camera.record": "录像",
  "camera.look": "看看",
  "gallery.open": "相册",
  "gallery.describe": "描述照片",
  "vision.watch": "环境观察",
  "navigation.start": "导航",
  "navigation.stop": "导航",
  "system.shutdown": "关机"
};

/** The line Max speaks when a command did not succeed. Never claims success and
 *  never invents a cause it was not given. */
export function deviceFailureSpeech(
  action: DeviceActionName,
  status: DeviceActionStatus,
  reason: string | undefined
): string {
  if (status === "ok") throw new Error("deviceFailureSpeech called for a successful command");
  if (reason && FAILURE_SPEECH[reason]) return FAILURE_SPEECH[reason];
  return `${ACTION_LABELS[action]}操作没成功。`;
}

const CONTACT_PLACEHOLDER = "[联系人]";

/** Strips spoken contact names before a rider turn is persisted for QA. Phone
 *  numbers never reach the relay at all; names would otherwise land in stored
 *  transcripts via metrics.recordTranscriptTurn. */
export function redactContactNames(text: string): string {
  const command = extractDeviceCommand(text);
  if (!command) return text;
  if (command.action === "call.dial" && command.args.name) {
    return text.replace(command.args.name, CONTACT_PLACEHOLDER);
  }
  if (command.action === "sms.compose") {
    return text.replace(command.args.name, CONTACT_PLACEHOLDER);
  }
  return text;
}

export type DeviceReconciliation = { truncate: boolean; speech: string | undefined };

/** Formats the whole-ride distance the way the relay speaks it: one decimal
 *  place below 10 km, a whole number at or above (10_000 m → "10", never
 *  "10.0"). Round-then-branch: round to one decimal FIRST, then branch on
 *  THAT rounded value. Branching on the raw km value first (distanceMeters <
 *  10_000 ? km.toFixed(1) : …) put every meter in [9_950, 9_999] on the
 *  one-decimal branch, and toFixed(1) rounds 9.975..9.999 up to "10.0" —
 *  the double-digit whole number bleeding a decimal back in. Rounding first
 *  (9_975 m → 9.975 → 10.0 → 10 >= 10) sends it to the whole-number branch
 *  instead, so it renders "10", matching every other value at or above 10 km.
 *
 *  The whole-number branch itself rounds the RAW km value (distanceMeters /
 *  1000), never `roundedKm` — rounding twice compounds: 10_460 m → 10.46 km
 *  → round to 1 decimal → 10.5 → round again → "11", when 10.46 km's one
 *  correct rounding is "10". `roundedKm` exists only to decide which branch
 *  applies; each branch does its own single, final rounding from the raw
 *  value. */
function formatRouteKm(distanceMeters: number): string {
  const km = distanceMeters / 1000;
  const roundedKm = Math.round(km * 10) / 10;
  return roundedKm >= 10 ? String(Math.round(km)) : roundedKm.toFixed(1);
}

/** The relay-spoken start summary, composed from the exact nav.route payload
 *  once `createNavHandler` has resolved a destination and planned a route.
 *  Pure so the wording is table-testable without a provider or a socket. */
export function navRouteOkSpeech(destinationName: string, distanceMeters: number, etaSeconds: number): string {
  const minutes = Math.ceil(etaSeconds / 60);
  return `已找到${destinationName}，全程${formatRouteKm(distanceMeters)}公里，预计${minutes}分钟。仅供参考，请注意实际路况。`;
}

/** The relay-spoken reroute-success line. Fired only by createNavHandler's
 *  FRESH, non-superseded, successful reroute path (see its
 *  onRerouteAnnounced option) — never for the cache-resend fast path, a
 *  superseded reroute, or a nav.error. Relay-side lines carry 。, the same
 *  trailing-punctuation convention navRouteOkSpeech uses. Exported (rather
 *  than inlined at the routing.ts call site) so the composer and its
 *  wording live in one place and the tests assert against the same
 *  constant instead of a duplicated string literal. */
export const REROUTE_OK_SPEECH = "已重新规划路线。";

/** The short line Max speaks when an action succeeds. Deterministic and tied to
 *  the real device result, so the rider hears the truth ("拍好了", "开始录像")
 *  instead of the model's chatter or a mistaken safety refusal. navigation.start
 *  returns undefined here for a different reason than the other actions below
 *  it that share this shape (dialing, SMS: system UI owns their confirmation):
 *  at dispatch time the relay has not resolved a destination or planned a
 *  route yet, so there is no summary to speak. `createNavHandler`'s
 *  `onRouteAnnounced` composes the real line via `navRouteOkSpeech` once the
 *  route is known, and attaches it after the fact through
 *  `PendingDeviceCommands.attachOkSpeech` — see server/session-controller.ts. */
export function deviceSuccessSpeech(command: DeviceCommand): string | undefined {
  switch (command.action) {
    case "camera.photo":
      return "拍好了。";
    case "camera.record":
      return command.args.start ? "开始录像。" : "已停止录像。";
    case "navigation.stop":
      return "已取消导航。";
    case "system.shutdown":
      // The board's countdown tones are the ground truth; this line matches
      // them rather than promising an instant poweroff.
      return command.args.cancel ? "已取消关机。" : "好的，10秒后关机；说取消关机可以撤销。";
    case "camera.look":
      // A filler, not the answer. The description arrives seconds later and is
      // spoken separately; silence here reads as "he didn't hear me" and gets
      // the question repeated, which would send a second frame.
      return "我看看…";
    case "gallery.describe":
      // A filler, not the answer. The description arrives seconds later and is
      // spoken separately; silence here reads as "he didn't hear me" and gets
      // the question repeated, which would send a second request.
      return "我看看…";
    case "torch.set":
      return command.args.on ? "手电筒开了。" : "手电筒关了。";
    case "volume.set":
      return command.args.direction === "up" ? "音量调大了。" : "音量调小了。";
    case "gallery.open":
      return "相册打开了。";
    case "vision.watch":
      return command.args.on ? "已开启环境观察。" : "已关闭环境观察。";
    case "music.control":
      switch (command.args.control) {
        case "play":
          return "开始播放。";
        case "pause":
          return "已暂停。";
        case "next":
          return "下一首。";
        case "previous":
          return "上一首。";
      }
      return undefined;
    default:
      return undefined;
  }
}

/** Decides what the relay does about a result. Pure so every branch is testable
 *  without a provider or a socket. On success, speaks the deterministic
 *  confirmation (cutting the model) when the action has one; otherwise stays
 *  silent so the action's own confirmation path stands. */
export function reconcileDeviceResult(
  action: DeviceActionName,
  result: { status: DeviceActionStatus; reason?: string; detail?: string },
  okSpeech?: string
): DeviceReconciliation {
  if (result.status === "ok") {
    return okSpeech ? { truncate: true, speech: okSpeech } : { truncate: false, speech: undefined };
  }
  const speech = result.detail?.trim() || deviceFailureSpeech(action, result.status, result.reason);
  return { truncate: true, speech };
}

export type IssuedDeviceCommand = {
  commandId: string;
  action: DeviceActionName;
  issuedAt: number;
  expiresAt: number;
  /** Deterministic confirmation to speak on success; see deviceSuccessSpeech. */
  okSpeech?: string;
  question?: string;
  /** The requested vision.watch toggle state. Task 3 flips the embedded
   *  watch governor on the matching device.result "ok". */
  watchOn?: boolean;
  /** Stateful follow-up target captured when the command was issued. */
  activity?: DeviceActivityIntent;
  /** Relay-owned route retirement, captured when navigation.stop is issued. */
  onNavigationStopped?: () => void;
};

/** Tracks dispatched commands so no command can be left pending forever. */
export class PendingDeviceCommands {
  private readonly pending = new Map<string, IssuedDeviceCommand>();

  issue(
    action: DeviceActionName,
    okSpeech?: string,
    now: number = Date.now(),
    question?: string,
    watchOn?: boolean,
    activity?: DeviceActivityIntent
  ): IssuedDeviceCommand {
    const expiresAt = now + (action === "navigation.start" ? NAVIGATION_RESULT_TIMEOUT_MS : DEVICE_RESULT_TIMEOUT_MS);
    const issued: IssuedDeviceCommand = {
      commandId: randomUUID(),
      action,
      issuedAt: now,
      expiresAt,
      okSpeech,
      question,
      watchOn,
      ...(activity === undefined ? {} : { activity })
    };
    this.pending.set(issued.commandId, issued);
    return issued;
  }

  resolve(commandId: string, now: number = Date.now()): IssuedDeviceCommand | undefined {
    const issued = this.pending.get(commandId);
    if (!issued || now >= issued.expiresAt) return undefined;
    this.pending.delete(commandId);
    return issued;
  }

  /** Looks up a still-pending command WITHOUT consuming it. Used to verify a
   *  `camera.frame`'s commandId corresponds to a `camera.look` this relay
   *  actually issued, before paying for a vision-model call on whatever image
   *  arrived — the frame is not itself the command's result and must not
   *  resolve (and thereby delete) the entry that the later `device.result`
   *  for the same commandId still needs to resolve. */
  peek(commandId: string, now: number = Date.now()): IssuedDeviceCommand | undefined {
    const issued = this.pending.get(commandId);
    return issued && now < issued.expiresAt ? issued : undefined;
  }

  /** Attaches okSpeech to the most recently issued unexpired command with this
   *  action — used by navigation.start, whose real confirmation is not known
   *  at dispatch time (see navRouteOkSpeech / createNavHandler's
   *  onRouteAnnounced). Silent no-op when none is outstanding: expired, or a
   *  reroute forward with no start currently in flight. Ties break by
   *  insertion order; last write wins if called more than once. */
  attachOkSpeech(action: DeviceActionName, okSpeech: string, now: number = Date.now()): void {
    let target: IssuedDeviceCommand | undefined;
    for (const issued of this.pending.values()) {
      if (issued.action !== action || now >= issued.expiresAt) continue;
      if (!target || issued.issuedAt >= target.issuedAt) target = issued;
    }
    if (target) target.okSpeech = okSpeech;
  }

  /** Removes and returns every command that has outlived the timeout. */
  expire(now: number = Date.now()): IssuedDeviceCommand[] {
    const expired: IssuedDeviceCommand[] = [];
    for (const issued of this.pending.values()) {
      if (now >= issued.expiresAt) expired.push(issued);
    }
    for (const issued of expired) this.pending.delete(issued.commandId);
    return expired;
  }

  nextExpiryAt(): number | undefined {
    let next: number | undefined;
    for (const issued of this.pending.values()) {
      if (next === undefined || issued.expiresAt < next) next = issued.expiresAt;
    }
    return next;
  }
}

function matchCall(raw: string): DeviceCommand | null {
  const zh = /(?:打电话给|打给|呼叫|拨给)\s*(?<name>[^\s，,。]{1,12})/.exec(raw);
  if (zh?.groups?.name) {
    const name = clean(zh.groups.name);
    if (name) return { action: "call.dial", args: { name } };
  }
  const en = /\bcall\s+(?<name>[A-Za-z一-鿿][^\s,.]*)/i.exec(raw);
  if (en?.groups?.name) {
    const name = clean(en.groups.name);
    if (name) return { action: "call.dial", args: { name } };
  }
  return null;
}

/**
 * Companion pairing voice confirm. Deliberately narrow — the registry calls
 * this ONLY while a pairing confirm is pending on the device, so ordinary
 * conversation can never bind a phone. Decline wins over accept so 取消确认
 * ("cancel the confirmation") cannot pair.
 */
export function matchPairConfirmReply(text: string): "accept" | "decline" | undefined {
  if (/取消/.test(text)) return "decline";
  if (/确认/.test(text)) return "accept";
  return undefined;
}
