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
  | "destination.show";

export type DeviceActionTier = "low" | "high";

export type DeviceActionStatus = "ok" | "failed" | "denied" | "unsupported";

export type DeviceCommand =
  | { action: "torch.set"; args: { on: boolean } }
  | { action: "volume.set"; args: { direction: "up" | "down" } }
  | { action: "music.control"; args: { control: "play" | "pause" | "next" | "previous"; app?: string } }
  | { action: "sms.compose"; args: { name: string; body: string } }
  | { action: "call.dial"; args: { name?: string; number?: string } }
  | { action: "destination.show"; args: { query: string } };

/** Declared risk. iOS satisfies the high tier with the native system
 *  confirmation that `tel:` and MFMessageComposeViewController already force;
 *  the field exists for the camera (Spec 2) and for Android. */
export const DEVICE_ACTION_TIERS: Record<DeviceActionName, DeviceActionTier> = {
  "torch.set": "low",
  "volume.set": "low",
  "music.control": "low",
  "sms.compose": "high",
  "call.dial": "high",
  "destination.show": "low"
};

export type IntentExtractor = (text: string) => DeviceCommand | null;

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
    /(turn|switch|put)\s+off\s+(the\s+)?(flash\s?light|torch)/i.test(raw)
  ) {
    return { action: "torch.set", args: { on: false } };
  }

  if (/(大声|响一点|声音.{0,2}大|调大|louder|speak up|volume up)/i.test(raw)) {
    return { action: "volume.set", args: { direction: "up" } };
  }
  if (/(小声|轻一点|声音.{0,2}小|调小|quieter|softer|volume down)/i.test(raw)) {
    return { action: "volume.set", args: { direction: "down" } };
  }

  const music = matchMusic(raw);
  if (music) return music;

  const sms = matchSms(raw);
  if (sms) return sms;

  const destination = matchDestination(raw);
  if (destination) return destination;

  const call = matchCall(raw);
  if (call) return call;

  return null;
};

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
  const zh = /给\s*(?<name>[^\s，,。]{1,12})\s*发(?:条|个)?\s*(?:短信|信息|消息)\s*(?:说|内容是|:|：)?\s*(?<body>.+)/.exec(raw);
  if (zh?.groups?.name && zh.groups.body) {
    return { action: "sms.compose", args: { name: clean(zh.groups.name), body: clean(zh.groups.body) } };
  }
  const en = /(?:text|message|send a (?:text|message) to)\s+(?<name>[^\s]+)\s+(?:saying|that)\s+(?<body>.+)/i.exec(raw);
  if (en?.groups?.name && en.groups.body) {
    return { action: "sms.compose", args: { name: clean(en.groups.name), body: clean(en.groups.body) } };
  }
  return null;
}

function matchDestination(raw: string): DeviceCommand | null {
  const zh = /(?:导航|带我|我要)\s*(?:去|到|回)\s*(?<query>.+)/.exec(raw);
  if (zh?.groups?.query) {
    const query = clean(zh.groups.query);
    if (query) return { action: "destination.show", args: { query } };
  }
  const en = /(?:navigate|directions|take me|route)\s+to\s+(?<query>.+)/i.exec(raw);
  if (en?.groups?.query) {
    const query = clean(en.groups.query);
    if (query) return { action: "destination.show", args: { query } };
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
  "route.unavailable": "这个目的地我查不到路线。",
  "contact.notFound": "通讯录里没找到这个人。",
  "torch.unavailable": "这台设备没有可用的手电筒。"
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
  return "刚才那个操作没成功。";
}

export type IssuedDeviceCommand = { commandId: string; action: DeviceActionName; issuedAt: number };

/** Tracks dispatched commands so no command can be left pending forever. */
export class PendingDeviceCommands {
  private readonly pending = new Map<string, IssuedDeviceCommand>();

  issue(action: DeviceActionName, now: number = Date.now()): IssuedDeviceCommand {
    const issued: IssuedDeviceCommand = { commandId: randomUUID(), action, issuedAt: now };
    this.pending.set(issued.commandId, issued);
    return issued;
  }

  resolve(commandId: string): IssuedDeviceCommand | undefined {
    const issued = this.pending.get(commandId);
    if (issued) this.pending.delete(commandId);
    return issued;
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
