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
  | { action: "camera.look"; args: Record<string, never> }
  | { action: "gallery.open"; args: Record<string, never> }
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
  "navigation.start": "low",
  "navigation.stop": "low",
  // High like dialing: consequential, and satisfied on the board by the 10 s
  // cancellable countdown the way iOS satisfies it with native confirms.
  "system.shutdown": "high"
};

export type IntentExtractor = (text: string) => DeviceCommand | null;

/**
 * Actions whose detection is restricted to a specific client platform, keyed
 * by the platform string the session reports at `session.start`.
 *
 * `camera.look` is the first entry: it requires the relay to dispatch a
 * `device.command` that fetches a live frame, and only the embedded board's
 * dispatcher implements that action (`rdk/agent/src/device/dispatch.ts`). On
 * iOS an action with no local handler falls through to `.unhandled`, which
 * never sends a `device.result` back — the rider then sits through the full
 * `DEVICE_RESULT_TIMEOUT_MS` in silence before a generic timeout line, instead
 * of getting an ordinary spoken answer from the model. Every other
 * `DeviceActionName` already has a real handler on every platform it is
 * dispatched to, so it is absent from this map and detected everywhere, as
 * before.
 */
const PLATFORM_RESTRICTED_ACTIONS: Partial<Record<DeviceActionName, string>> = {
  "camera.look": "embedded",
  // Phones cannot poweroff, and an older app build receiving an unknown
  // action would sit out the result timeout in silence.
  "system.shutdown": "embedded"
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
  const requiredPlatform = PLATFORM_RESTRICTED_ACTIONS[command.action];
  if (requiredPlatform && platform !== requiredPlatform) return null;
  return command;
}

/** Players we cannot drive. MPMusicPlayerController reaches only Apple Music and
 *  the local library; naming any of these must produce an honest refusal rather
 *  than silently controlling the wrong player. */
const THIRD_PARTY_PLAYERS: Array<[RegExp, string]> = [
  [/网易云(音乐)?/, "网易云音乐"],
  [/qq\s*音乐/i, "QQ音乐"],
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

function matchCamera(raw: string): DeviceCommand | null {
  // Stop is checked before start so "停止录像" is never read as "录像", and its
  // grammar is deliberately more generous than start's: an over-matched stop
  // fails honestly as "现在没有在录像", while an under-matched one leaves the
  // camera rolling behind a narrated save that never happened — a live session
  // said "帮我停一下录视频", fell through to the start grammar's bare 录视频,
  // and got "已经在录了" plus that fiction. (?!车) keeps 停车 (parking) from
  // reading as a stop verb; the gap covers filler like 一下 / 刚才的.
  if (
    /(停止|结束|暂停|关闭|关掉|停一下|停下|停)(?!车).{0,3}(录像|录制|录影|摄像|视频|拍摄)/.test(raw) ||
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
  if (/(你能?看到?什么|前面是什么|看看前面|看一下前面)/.test(raw) || /what\s+(do|can)\s+you\s+see/i.test(raw)) {
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
  if (/(下一首|下一曲|next (track|song))/i.test(raw)) control = "next";
  else if (/(上一首|上一曲|previous (track|song))/i.test(raw)) control = "previous";
  else if (/(暂停|停一下|pause)/i.test(raw) && /(音乐|歌|music|song)/i.test(raw)) control = "pause";
  else if (/(放歌|播放音乐|放音乐|来点音乐|play (some )?music)/i.test(raw)) control = "play";
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

/** How long the relay waits for a device.result before treating the command as
 *  failed. Long enough for the rider to read a permission prompt, short enough
 *  that Max does not go quiet mid-ride. */
export const DEVICE_RESULT_TIMEOUT_MS = 8_000;

const FAILURE_SPEECH: Record<string, string> = {
  "permission.contacts": "我没有通讯录权限，去设置里开启后我再帮你拨号。",
  "permission.music": "我没有音乐库权限，去设置里开启后我再帮你播放。",
  "device.locked": "手机锁屏了，解锁后我再执行。",
  "unsafe.speed": "骑行中我不发短信，停车以后我再帮你发。",
  "player.unsupported": "我只能控制 Apple Music 和本机音乐。",
  // Shared by the phone's destination.show device action and the relay's own
  // nav.request handling (server/routing.ts) and the embedded navigation
  // controller's device.result reason — one reason code, one truthful line.
  "destination.notFound": "没找到这个地方。",
  "route.unavailable": "路线规划失败。",
  "contact.notFound": "通讯录里没找到这个人。",
  "torch.unavailable": "这台设备没有可用的手电筒。",
  "permission.camera": "我没有相机权限，去设置里开启后我再帮你拍。",
  "storage.full": "存储快满了，导出或删除一些内容后我再帮你拍。",
  "camera.recording": "已经在录了。",
  "camera.notRecording": "现在没有在录像。",
  "shutdown.notPending": "现在没有要关机。",
  "capture.failed": "拍摄没成功。",
  "vision.sharingOff": "我现在不能看。",
  "navigation.notActive": "现在没有在导航。",
  "permission.location": "我没有定位权限，去设置里开启后我再帮你导航。",
  // Embedded (helmet) refusals. Worded generically because "device.noScreen"
  // serves both gallery.open and destination.show. Navigation gets its own code
  // rather than borrowing device.noPhone: audio-only turn-by-turn needs neither
  // a phone nor a screen, so either would be a false explanation.
  "device.noScreen": "头盔上没有屏幕，看不了。",
  "device.noPhone": "头盔上没有手机功能，这个我做不了。",
  "device.notYet": "这个功能头盔上还没上线。"
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

/** The short line Max speaks when an action succeeds. Deterministic and tied to
 *  the real device result, so the rider hears the truth ("拍好了", "开始录像")
 *  instead of the model's chatter or a mistaken safety refusal. Actions that
 *  speak their own confirmation elsewhere — navigation (client card + summary),
 *  dialing and SMS (system UI) — return undefined and keep that path. */
export function deviceSuccessSpeech(command: DeviceCommand): string | undefined {
  switch (command.action) {
    case "camera.photo":
      return "拍好了。";
    case "camera.record":
      return command.args.start ? "开始录像。" : "已停止录像。";
    case "system.shutdown":
      // The board's countdown tones are the ground truth; this line matches
      // them rather than promising an instant poweroff.
      return command.args.cancel ? "已取消关机。" : "好的，10秒后关机；说取消关机可以撤销。";
    case "camera.look":
      // A filler, not the answer. The description arrives seconds later and is
      // spoken separately; silence here reads as "he didn't hear me" and gets
      // the question repeated, which would send a second frame.
      return "我看看…";
    case "torch.set":
      return command.args.on ? "手电筒开了。" : "手电筒关了。";
    case "volume.set":
      return command.args.direction === "up" ? "音量调大了。" : "音量调小了。";
    case "gallery.open":
      return "相册打开了。";
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
  /** Deterministic confirmation to speak on success; see deviceSuccessSpeech. */
  okSpeech?: string;
};

/** Tracks dispatched commands so no command can be left pending forever. */
export class PendingDeviceCommands {
  private readonly pending = new Map<string, IssuedDeviceCommand>();

  issue(action: DeviceActionName, okSpeech?: string, now: number = Date.now()): IssuedDeviceCommand {
    const issued: IssuedDeviceCommand = { commandId: randomUUID(), action, issuedAt: now, okSpeech };
    this.pending.set(issued.commandId, issued);
    return issued;
  }

  resolve(commandId: string): IssuedDeviceCommand | undefined {
    const issued = this.pending.get(commandId);
    if (issued) this.pending.delete(commandId);
    return issued;
  }

  /** Looks up a still-pending command WITHOUT consuming it. Used to verify a
   *  `camera.frame`'s commandId corresponds to a `camera.look` this relay
   *  actually issued, before paying for a vision-model call on whatever image
   *  arrived — the frame is not itself the command's result and must not
   *  resolve (and thereby delete) the entry that the later `device.result`
   *  for the same commandId still needs to resolve. */
  peek(commandId: string): IssuedDeviceCommand | undefined {
    return this.pending.get(commandId);
  }

  /** Removes and returns every command that has outlived the timeout. */
  expire(now: number = Date.now()): IssuedDeviceCommand[] {
    const expired: IssuedDeviceCommand[] = [];
    for (const issued of this.pending.values()) {
      if (now - issued.issuedAt >= DEVICE_RESULT_TIMEOUT_MS) expired.push(issued);
    }
    for (const issued of expired) this.pending.delete(issued.commandId);
    return expired;
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
