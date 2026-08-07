import { describe, expect, it } from "vitest";
import {
  DEVICE_ACTION_TIERS,
  DEVICE_RESULT_TIMEOUT_MS,
  PendingDeviceCommands,
  deviceFailureSpeech,
  deviceSuccessSpeech,
  extractDeviceCommand,
  extractDeviceCommandForPlatform
} from "../server/device-actions";
import { parseClientEvent } from "../server/session-controller";

describe("extractDeviceCommand — torch", () => {
  it("turns the torch on in Chinese and English", () => {
    expect(extractDeviceCommand("Max 打开手电筒")).toEqual({ action: "torch.set", args: { on: true } });
    expect(extractDeviceCommand("Max，开灯")).toEqual({ action: "torch.set", args: { on: true } });
    expect(extractDeviceCommand("Max turn on the flashlight")).toEqual({ action: "torch.set", args: { on: true } });
  });

  it("turns the torch off", () => {
    expect(extractDeviceCommand("Max 关闭手电筒")).toEqual({ action: "torch.set", args: { on: false } });
    expect(extractDeviceCommand("Max turn off the torch")).toEqual({ action: "torch.set", args: { on: false } });
  });
});

describe("extractDeviceCommand — volume", () => {
  it("raises and lowers Max's own voice", () => {
    expect(extractDeviceCommand("Max 大声一点")).toEqual({ action: "volume.set", args: { direction: "up" } });
    expect(extractDeviceCommand("Max louder please")).toEqual({ action: "volume.set", args: { direction: "up" } });
    expect(extractDeviceCommand("Max 小声一点")).toEqual({ action: "volume.set", args: { direction: "down" } });
    expect(extractDeviceCommand("Max quieter")).toEqual({ action: "volume.set", args: { direction: "down" } });
  });
});

describe("extractDeviceCommand — music", () => {
  it("controls the system player", () => {
    expect(extractDeviceCommand("Max 放歌")).toEqual({ action: "music.control", args: { control: "play" } });
    expect(extractDeviceCommand("Max 下一首")).toEqual({ action: "music.control", args: { control: "next" } });
    expect(extractDeviceCommand("Max 上一首")).toEqual({ action: "music.control", args: { control: "previous" } });
    expect(extractDeviceCommand("Max pause the music")).toEqual({
      action: "music.control",
      args: { control: "pause" }
    });
  });

  it("tags a named third-party player so the handler can refuse it", () => {
    expect(extractDeviceCommand("Max 用网易云放歌")).toEqual({
      action: "music.control",
      args: { control: "play", app: "网易云音乐" }
    });
    expect(extractDeviceCommand("Max play music on Spotify")).toEqual({
      action: "music.control",
      args: { control: "play", app: "Spotify" }
    });
  });
});

describe("extractDeviceCommand — sms", () => {
  it("extracts recipient and body", () => {
    expect(extractDeviceCommand("Max 给老王发条短信说我晚点到")).toEqual({
      action: "sms.compose",
      args: { name: "老王", body: "我晚点到" }
    });
    expect(extractDeviceCommand("Max text Wang saying running late")).toEqual({
      action: "sms.compose",
      args: { name: "Wang", body: "running late" }
    });
  });
});

describe("extractDeviceCommand — calling", () => {
  it("extracts a spoken contact name", () => {
    expect(extractDeviceCommand("Max 打给老王")).toEqual({ action: "call.dial", args: { name: "老王" } });
    expect(extractDeviceCommand("Max call Wang")).toEqual({ action: "call.dial", args: { name: "Wang" } });
  });

  it("maps emergency phrases to fixed numbers", () => {
    expect(extractDeviceCommand("Max 报警")).toEqual({ action: "call.dial", args: { number: "110" } });
    expect(extractDeviceCommand("Max 叫救护车")).toEqual({ action: "call.dial", args: { number: "120" } });
    expect(extractDeviceCommand("Max 叫交警")).toEqual({ action: "call.dial", args: { number: "122" } });
  });
});

describe("extractDeviceCommand — negatives", () => {
  it("ignores utterances that are not commands", () => {
    expect(extractDeviceCommand("Max 今天天气怎么样")).toBeNull();
    expect(extractDeviceCommand("Max 刚才那个电话是谁打的")).toBeNull();
    expect(extractDeviceCommand("Max what is the next exit")).toBeNull();
    expect(extractDeviceCommand("")).toBeNull();
  });

  it("respects negation", () => {
    expect(extractDeviceCommand("Max 别开手电筒")).toBeNull();
    expect(extractDeviceCommand("Max 不用放歌了")).toBeNull();
    expect(extractDeviceCommand("Max don't call Wang")).toBeNull();
  });
});

describe("deviceFailureSpeech", () => {
  it("explains a denied permission", () => {
    expect(deviceFailureSpeech("call.dial", "denied", "permission.contacts")).toContain("通讯录");
  });

  it("explains a locked phone", () => {
    expect(deviceFailureSpeech("torch.set", "failed", "device.locked")).toContain("锁屏");
  });

  it("explains the speed refusal", () => {
    expect(deviceFailureSpeech("sms.compose", "denied", "unsafe.speed")).toContain("停车");
  });

  it("explains an unreachable third-party player", () => {
    expect(deviceFailureSpeech("music.control", "unsupported", "player.unsupported")).toContain("本机音乐");
  });

  it("explains an unresolvable destination", () => {
    expect(deviceFailureSpeech("destination.show", "unsupported", "route.unavailable")).toContain("路线");
  });

  it("names the failed action when no known reason is supplied", () => {
    expect(deviceFailureSpeech("torch.set", "failed", undefined)).toBe("手电筒操作没成功。");
    expect(deviceFailureSpeech("call.dial", "failed", "unrecognized-key")).toBe("电话操作没成功。");
  });
});

describe("deviceSuccessSpeech", () => {
  it("gives a short deterministic confirmation per action", () => {
    expect(deviceSuccessSpeech({ action: "camera.photo", args: {} })).toBe("拍好了。");
    expect(deviceSuccessSpeech({ action: "camera.record", args: { start: true } })).toBe("开始录像。");
    expect(deviceSuccessSpeech({ action: "camera.record", args: { start: false } })).toBe("已停止录像。");
    expect(deviceSuccessSpeech({ action: "torch.set", args: { on: true } })).toBe("手电筒开了。");
    expect(deviceSuccessSpeech({ action: "torch.set", args: { on: false } })).toBe("手电筒关了。");
  });

  it("leaves navigation and dialing to their own confirmation path", () => {
    expect(deviceSuccessSpeech({ action: "navigation.start", args: { query: "x" } })).toBeUndefined();
    expect(deviceSuccessSpeech({ action: "call.dial", args: { number: "110" } })).toBeUndefined();
  });
});

describe("PendingDeviceCommands", () => {
  it("issues unique ids and resolves them once", () => {
    const pending = new PendingDeviceCommands();
    const a = pending.issue("torch.set");
    const b = pending.issue("torch.set");
    expect(a.commandId).not.toEqual(b.commandId);
    expect(pending.resolve(a.commandId)?.action).toBe("torch.set");
    expect(pending.resolve(a.commandId)).toBeUndefined();
  });

  it("expires commands past the timeout and only those", () => {
    const pending = new PendingDeviceCommands();
    const issued = pending.issue("call.dial");
    expect(pending.expire(issued.issuedAt + DEVICE_RESULT_TIMEOUT_MS - 1)).toEqual([]);
    expect(pending.expire(issued.issuedAt + DEVICE_RESULT_TIMEOUT_MS)).toEqual([
      { commandId: issued.commandId, action: "call.dial", issuedAt: issued.issuedAt }
    ]);
    expect(pending.expire(issued.issuedAt + DEVICE_RESULT_TIMEOUT_MS)).toEqual([]);
  });

  it("peek finds a pending command without consuming it", () => {
    const pending = new PendingDeviceCommands();
    const issued = pending.issue("camera.look");
    expect(pending.peek(issued.commandId)?.action).toBe("camera.look");
    // Still there — unlike resolve(), peek() must not remove the entry, since
    // the device.result that actually resolves it (deviceResult() in
    // server/providers/doubao.ts) arrives after the camera.frame that peeks it.
    expect(pending.peek(issued.commandId)?.action).toBe("camera.look");
    expect(pending.resolve(issued.commandId)?.action).toBe("camera.look");
    expect(pending.peek(issued.commandId)).toBeUndefined();
  });

  it("peek returns undefined for a commandId nobody issued", () => {
    const pending = new PendingDeviceCommands();
    expect(pending.peek("no-such-id")).toBeUndefined();
  });
});

describe("extractDeviceCommand — camera", () => {
  it("takes a photo in Chinese and English", () => {
    expect(extractDeviceCommand("Max 拍照")).toEqual({ action: "camera.photo", args: {} });
    expect(extractDeviceCommand("Max 拍张照片")).toEqual({ action: "camera.photo", args: {} });
    expect(extractDeviceCommand("Max take a photo")).toEqual({ action: "camera.photo", args: {} });
  });

  it("starts and stops recording, checking stop before start", () => {
    expect(extractDeviceCommand("Max 开始录像")).toEqual({ action: "camera.record", args: { start: true } });
    expect(extractDeviceCommand("Max 录个视频")).toEqual({ action: "camera.record", args: { start: true } });
    expect(extractDeviceCommand("Max start recording")).toEqual({ action: "camera.record", args: { start: true } });
    expect(extractDeviceCommand("Max 停止录像")).toEqual({ action: "camera.record", args: { start: false } });
    expect(extractDeviceCommand("Max stop recording")).toEqual({ action: "camera.record", args: { start: false } });
  });

  it("understands 拍-phrasings for video — a live session said 拍视频, matched nothing, and Max narrated a recording that never happened", () => {
    expect(extractDeviceCommand("Max 帮我拍视频")).toEqual({ action: "camera.record", args: { start: true } });
    expect(extractDeviceCommand("Max 拍个视频")).toEqual({ action: "camera.record", args: { start: true } });
    expect(extractDeviceCommand("Max 拍一段视频")).toEqual({ action: "camera.record", args: { start: true } });
    expect(extractDeviceCommand("Max 拍摄视频")).toEqual({ action: "camera.record", args: { start: true } });
    expect(extractDeviceCommand("Max 开始拍摄")).toEqual({ action: "camera.record", args: { start: true } });
    expect(extractDeviceCommand("Max shoot a video")).toEqual({ action: "camera.record", args: { start: true } });
    expect(extractDeviceCommand("Max take a video")).toEqual({ action: "camera.record", args: { start: true } });
    expect(extractDeviceCommand("Max 停止拍摄")).toEqual({ action: "camera.record", args: { start: false } });
    expect(extractDeviceCommand("Max 停止拍视频")).toEqual({ action: "camera.record", args: { start: false } });
  });

  it("stops for 停一下/暂停/关掉 phrasings — a live session said 帮我停一下录视频, was read as start, and Max narrated a save that never happened", () => {
    expect(extractDeviceCommand("Max 帮我停一下录视频")).toEqual({ action: "camera.record", args: { start: false } });
    expect(extractDeviceCommand("Max 停一下视频")).toEqual({ action: "camera.record", args: { start: false } });
    expect(extractDeviceCommand("Max 暂停录像")).toEqual({ action: "camera.record", args: { start: false } });
    expect(extractDeviceCommand("Max 关掉录像")).toEqual({ action: "camera.record", args: { start: false } });
    expect(extractDeviceCommand("Max 关闭录像")).toEqual({ action: "camera.record", args: { start: false } });
    expect(extractDeviceCommand("Max 停止摄像")).toEqual({ action: "camera.record", args: { start: false } });
    expect(extractDeviceCommand("Max 停止刚才的录像")).toEqual({ action: "camera.record", args: { start: false } });
  });

  it("treats a negated 录 as a stop command, like the negated 关机 — not noise", () => {
    expect(extractDeviceCommand("Max 别录了")).toEqual({ action: "camera.record", args: { start: false } });
    expect(extractDeviceCommand("Max 不要录了")).toEqual({ action: "camera.record", args: { start: false } });
    expect(extractDeviceCommand("Max 别再录视频了")).toEqual({ action: "camera.record", args: { start: false } });
    expect(extractDeviceCommand("Max 不录了")).toEqual({ action: "camera.record", args: { start: false } });
  });

  it("stops for wider English phrasings than the bare 'stop recording'", () => {
    expect(extractDeviceCommand("Max stop the recording")).toEqual({ action: "camera.record", args: { start: false } });
    expect(extractDeviceCommand("Max stop the video")).toEqual({ action: "camera.record", args: { start: false } });
    expect(extractDeviceCommand("Max end the recording")).toEqual({ action: "camera.record", args: { start: false } });
    expect(extractDeviceCommand("Max finish recording")).toEqual({ action: "camera.record", args: { start: false } });
    expect(extractDeviceCommand("Max stop filming")).toEqual({ action: "camera.record", args: { start: false } });
    expect(extractDeviceCommand("Max pause the video")).toEqual({ action: "camera.record", args: { start: false } });
  });

  it("keeps parking (停车) and music playback out of the stop grammar", () => {
    expect(extractDeviceCommand("Max 停车后帮我录个视频")).toEqual({ action: "camera.record", args: { start: true } });
    expect(extractDeviceCommand("Max 停车再录制")).toEqual({ action: "camera.record", args: { start: true } });
    expect(extractDeviceCommand("Max 暂停音乐")).toEqual({ action: "music.control", args: { control: "pause" } });
    expect(extractDeviceCommand("Max pause the music")).toEqual({
      action: "music.control",
      args: { control: "pause" }
    });
  });

  it("keeps 拍视频 clear of photo, negation, and garbled ASR", () => {
    expect(extractDeviceCommand("Max 拍张照片")?.action).toBe("camera.photo");
    expect(extractDeviceCommand("Max 别拍视频")).toBeNull();
    // The 22:13 stop attempt arrived garbled as this; it must stay unmatched
    // rather than start a recording.
    expect(extractDeviceCommand("Max 帮我听一下开视频")).toBeNull();
  });

  it("arms a shutdown, in Chinese and English", () => {
    expect(extractDeviceCommand("Max 关机")).toEqual({ action: "system.shutdown", args: {} });
    expect(extractDeviceCommand("Max 帮我关机")).toEqual({ action: "system.shutdown", args: {} });
    expect(extractDeviceCommand("Max shut down")).toEqual({ action: "system.shutdown", args: {} });
    expect(extractDeviceCommand("Max power off")).toEqual({ action: "system.shutdown", args: {} });
  });

  it("cancels a shutdown — including negated phrasings, which are commands here, not noise", () => {
    expect(extractDeviceCommand("Max 取消关机")).toEqual({ action: "system.shutdown", args: { cancel: true } });
    expect(extractDeviceCommand("Max 别关机")).toEqual({ action: "system.shutdown", args: { cancel: true } });
    expect(extractDeviceCommand("Max 不要关机")).toEqual({ action: "system.shutdown", args: { cancel: true } });
    expect(extractDeviceCommand("Max cancel the shutdown")).toEqual({
      action: "system.shutdown",
      args: { cancel: true }
    });
  });

  it("does not read the rider's dead phone, the torch, or music as a shutdown", () => {
    expect(extractDeviceCommand("Max 我手机关机了")).toBeNull();
    expect(extractDeviceCommand("Max power off the flashlight")?.action).toBe("torch.set");
    expect(extractDeviceCommand("Max shut down the music")).toBeNull();
  });

  it("only the embedded platform may receive a shutdown", () => {
    expect(extractDeviceCommandForPlatform("Max 关机", "embedded")?.action).toBe("system.shutdown");
    expect(extractDeviceCommandForPlatform("Max 关机", "ios")).toBeNull();
    expect(extractDeviceCommandForPlatform("Max 关机", undefined)).toBeNull();
  });

  it("speaks the countdown truthfully", () => {
    expect(deviceSuccessSpeech({ action: "system.shutdown", args: {} })).toBe("好的，10秒后关机；说取消关机可以撤销。");
    expect(deviceSuccessSpeech({ action: "system.shutdown", args: { cancel: true } })).toBe("已取消关机。");
    expect(deviceFailureSpeech("system.shutdown", "failed", "shutdown.notPending")).toBe("现在没有要关机。");
  });

  it("opens the gallery", () => {
    expect(extractDeviceCommand("Max 打开相册")).toEqual({ action: "gallery.open", args: {} });
    expect(extractDeviceCommand("Max open the gallery")).toEqual({ action: "gallery.open", args: {} });
  });

  it("respects negation and non-commands", () => {
    expect(extractDeviceCommand("Max 别拍照")).toBeNull();
    expect(extractDeviceCommand("Max 我们刚才拍的照片在哪")).toBeNull();
  });

  it("detects a request to look", () => {
    for (const phrase of ["你能看到什么", "前面是什么", "看看前面", "what do you see"]) {
      expect(extractDeviceCommand(phrase)?.action).toBe("camera.look");
    }
  });

  it("does not mistake looking for taking a photo", () => {
    // 拍照 must still win; the two are separate actions with separate speech.
    expect(extractDeviceCommand("帮我拍照")?.action).toBe("camera.photo");
    expect(extractDeviceCommand("打开相册")?.action).toBe("gallery.open");
  });
});

describe("extractDeviceCommandForPlatform — camera.look is embedded-only", () => {
  // Only the embedded board's dispatcher fetches a frame for camera.look
  // (rdk/agent/src/device/dispatch.ts). On any other client, dispatching a
  // device.command no one answers would sit the rider through the full
  // DEVICE_RESULT_TIMEOUT_MS in silence before a generic timeout line — so
  // detection itself is gated to an "embedded" session, and the phrase must
  // fall through to ordinary conversation everywhere else.
  it("detects camera.look for an embedded session", () => {
    expect(extractDeviceCommandForPlatform("你能看到什么", "embedded")).toEqual({
      action: "camera.look",
      args: {}
    });
  });

  it("does not detect camera.look for a web session — falls through to conversation", () => {
    expect(extractDeviceCommandForPlatform("你能看到什么", "web")).toBeNull();
  });

  it("does not detect camera.look for an ios session", () => {
    expect(extractDeviceCommandForPlatform("看看前面", "ios")).toBeNull();
  });

  it("does not detect camera.look when the platform is unknown", () => {
    expect(extractDeviceCommandForPlatform("what do you see", undefined)).toBeNull();
  });

  it("leaves every other action ungated by platform", () => {
    expect(extractDeviceCommandForPlatform("Max 拍照", "web")).toEqual({ action: "camera.photo", args: {} });
    expect(extractDeviceCommandForPlatform("Max 打开手电筒", "web")).toEqual({
      action: "torch.set",
      args: { on: true }
    });
  });
});

describe("extractDeviceCommand — navigation", () => {
  it("starts guidance in Chinese and English", () => {
    expect(extractDeviceCommand("Max 导航去天安门")).toEqual({ action: "navigation.start", args: { query: "天安门" } });
    expect(extractDeviceCommand("Max 带我去公司")).toEqual({ action: "navigation.start", args: { query: "公司" } });
    expect(extractDeviceCommand("Max navigate to the airport")).toEqual({
      action: "navigation.start",
      args: { query: "the airport" }
    });
  });

  it("stops guidance, checked before start so 停止导航 is not a destination", () => {
    expect(extractDeviceCommand("Max 停止导航")).toEqual({ action: "navigation.stop", args: {} });
    expect(extractDeviceCommand("Max 取消导航")).toEqual({ action: "navigation.stop", args: {} });
    expect(extractDeviceCommand("Max stop navigation")).toEqual({ action: "navigation.stop", args: {} });
  });

  it("no longer emits destination.show for navigation phrasing", () => {
    expect(extractDeviceCommand("Max 导航去天安门")?.action).not.toBe("destination.show");
  });
});

describe("DEVICE_ACTION_TIERS", () => {
  it("marks messaging, calling, and shutdown as high risk", () => {
    expect(DEVICE_ACTION_TIERS).toEqual({
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
      "system.shutdown": "high"
    });
  });
});

describe("camera.look vision questions", () => {
  it("keeps generic look phrases question-free (fixed prompt)", () => {
    for (const phrase of ["你能看到什么", "看看前面", "what do you see"]) {
      const command = extractDeviceCommand(phrase);
      expect(command).toMatchObject({ action: "camera.look", args: {} });
      expect(command?.args).not.toHaveProperty("question");
    }
  });

  it("carries the raw utterance for specific questions", () => {
    for (const phrase of ["前面那个路牌写的什么", "前方的标志是什么", "前面那辆车是什么样", "what is that ahead"]) {
      const command = extractDeviceCommand(phrase);
      expect(command).toMatchObject({ action: "camera.look", args: { question: phrase } });
    }
  });

  it("does not swallow gallery phrases", () => {
    expect(extractDeviceCommand("看看相册")).toMatchObject({ action: "gallery.open" });
    expect(extractDeviceCommand("打开相册")).toMatchObject({ action: "gallery.open" });
  });

  it("threads the question through PendingDeviceCommands.issue", () => {
    const pending = new PendingDeviceCommands();
    const issued = pending.issue("camera.look", "我看看…", Date.now(), "路牌写的什么");
    expect(pending.peek(issued.commandId)?.question).toBe("路牌写的什么");
    const plain = pending.issue("torch.set", "好的");
    expect(pending.peek(plain.commandId)?.question).toBeUndefined();
  });

  it("keeps navigation-intent phrases out of the vision grammar — guard prevents matchCamera from hijacking them before matchNavigation runs", () => {
    // A phrase with both a nav verb and nearby question words must go to navigation, not vision.
    // This probe-verified defect would have hijacked "导航去前面那个什么样的加油站" into camera.look.
    expect(extractDeviceCommand("导航去前面那个什么样的加油站")).toMatchObject({
      action: "navigation.start",
      args: { query: "前面那个什么样的加油站" }
    });
  });

  it("brings a 带我去 phrase out of vision grammar toward navigation", () => {
    expect(extractDeviceCommand("带我去前面是什么路的那个路口")).toMatchObject({
      action: "navigation.start",
      args: { query: "前面是什么路的那个路口" }
    });
  });

  it("distinguishes no-nav-verb vision questions from navigation phrases — the guard is verb-scoped", () => {
    // Without a nav verb, "前面那个路口是什么路" is genuinely asking about what is visible, not
    // requesting navigation. The guard must not exclude it; only the presence of 导航/带我去/怎么走 does.
    expect(extractDeviceCommand("前面那个路口是什么路")).toMatchObject({
      action: "camera.look",
      args: { question: "前面那个路口是什么路" }
    });
  });
});

describe("gallery.describe", () => {
  it("detects photo, video, and latest references", () => {
    expect(extractDeviceCommand("看看我刚拍的照片")).toMatchObject({
      action: "gallery.describe",
      args: { kind: "photo" }
    });
    expect(extractDeviceCommand("描述一下我拍的相片")).toMatchObject({
      action: "gallery.describe",
      args: { kind: "photo" }
    });
    expect(extractDeviceCommand("刚才录的视频里有什么")).toMatchObject({
      action: "gallery.describe",
      args: { kind: "video", question: "刚才录的视频里有什么" }
    });
    expect(extractDeviceCommand("看看我刚拍的")).toMatchObject({
      action: "gallery.describe",
      args: { kind: "latest" }
    });
  });

  it("carries a question only when one is asked", () => {
    const bare = extractDeviceCommand("看看我刚拍的照片");
    expect(bare?.args).not.toHaveProperty("question");
    expect(extractDeviceCommand("我刚拍的照片里那辆车是什么")).toMatchObject({
      action: "gallery.describe",
      args: { kind: "photo", question: "我刚拍的照片里那辆车是什么" }
    });
  });

  it("does not steal neighboring commands", () => {
    expect(extractDeviceCommand("拍照")).toMatchObject({ action: "camera.photo" });
    expect(extractDeviceCommand("看看相册")).toMatchObject({ action: "gallery.open" });
    expect(extractDeviceCommand("打开相册")).toMatchObject({ action: "gallery.open" });
    expect(extractDeviceCommand("你能看到什么")).toMatchObject({ action: "camera.look" });
  });

  it("is gated to ios", () => {
    expect(extractDeviceCommandForPlatform("看看我刚拍的照片", "ios")).toMatchObject({ action: "gallery.describe" });
    expect(extractDeviceCommandForPlatform("看看我刚拍的照片", "android")).toBeNull();
    expect(extractDeviceCommandForPlatform("看看我刚拍的照片", "embedded")).toBeNull();
  });

  it("speaks the filler on success and honest failures", () => {
    expect(deviceSuccessSpeech({ action: "gallery.describe", args: { kind: "photo" } })).toBe("我看看…");
    expect(deviceFailureSpeech("gallery.describe", "failed", "gallery.empty")).toBe("相册里还没有照片或视频。");
    expect(deviceFailureSpeech("gallery.describe", "failed", "gallery.unreadable")).toBe("这段内容我处理不了。");
  });

  it("recognizes English describe verbs", () => {
    expect(extractDeviceCommand("describe the video I just recorded")).toMatchObject({
      action: "gallery.describe",
      args: { kind: "video" }
    });
    expect(extractDeviceCommand("show me the photo I just took")).toMatchObject({
      action: "gallery.describe",
      args: { kind: "photo" }
    });
    expect(extractDeviceCommand("check the video we just recorded")).toMatchObject({
      action: "gallery.describe",
      args: { kind: "video" }
    });
  });

  it("carries English what questions", () => {
    expect(extractDeviceCommand("what's in the photo I just took")).toMatchObject({
      action: "gallery.describe",
      args: { kind: "photo", question: "what's in the photo I just took" }
    });
  });

  it("rejects delete, send, and navigate phrasings that reference recent media", () => {
    expect(extractDeviceCommand("把刚拍的照片删了")?.action).not.toBe("gallery.describe");
    expect(extractDeviceCommand("导航去我刚拍的地方")?.action).not.toBe("gallery.describe");
    expect(extractDeviceCommand("拍的照片发给我")?.action).not.toBe("gallery.describe");
  });

  it("caps the question at 500 bytes to respect the wire contract", () => {
    // Construct a phrase that exceeds 500 bytes when UTF-8 encoded.
    // "看看我刚拍的视频里有什么" is ~36 bytes; repeat "细节" (6 bytes per char) to push past 500.
    const base = "看看我刚拍的视频里有什么";
    const padded = base + "细节".repeat(120); // ~36 + 6*2*120 = ~1476 bytes
    const command = extractDeviceCommand(padded);
    expect(command).toMatchObject({ action: "gallery.describe", args: { kind: "video" } });
    expect(command?.args).toHaveProperty("question");
    const question = (command?.args as Record<string, unknown>)?.question;
    expect(Buffer.byteLength(question as string)).toBeLessThanOrEqual(500);
    expect(question).toBe(padded.substring(0, question?.length));
  });

  it("truncated question round-trips parseClientEvent", () => {
    const base = "看看我刚拍的视频里有什么";
    const padded = base + "细节".repeat(120);
    const command = extractDeviceCommand(padded);
    expect(command?.action).toBe("gallery.describe");
    const truncatedQuestion = (command?.args as Record<string, unknown>)?.question;
    expect(Buffer.byteLength(truncatedQuestion as string)).toBeLessThanOrEqual(500);
    // Construct a full vision.frames event with the truncated question and verify
    // parseClientEvent accepts it (the way tests/vision-frames-protocol.test.ts does).
    const event = {
      type: "vision.frames",
      commandId: "c1",
      reason: "gallery",
      index: 0,
      total: 1,
      image: "aGVsbG8=",
      question: truncatedQuestion
    };
    const parsed = parseClientEvent(Buffer.from(JSON.stringify(event)));
    expect(parsed).toMatchObject({ type: "vision.frames", question: truncatedQuestion });
  });
});

describe("vision.watch", () => {
  it("detects the toggle phrases in both languages", () => {
    expect(extractDeviceCommand("开启环境观察")).toMatchObject({ action: "vision.watch", args: { on: true } });
    expect(extractDeviceCommand("打开一下环境观察")).toMatchObject({ action: "vision.watch", args: { on: true } });
    expect(extractDeviceCommand("关闭环境观察")).toMatchObject({ action: "vision.watch", args: { on: false } });
    expect(extractDeviceCommand("stop watching")).toMatchObject({ action: "vision.watch", args: { on: false } });
    expect(extractDeviceCommand("start scene watching")).toMatchObject({ action: "vision.watch", args: { on: true } });
  });

  it("does not fire on unrelated 观察/watch phrases", () => {
    expect(extractDeviceCommand("观察一下路况")).toBeNull();
    expect(extractDeviceCommand("watch out")).toBeNull();
  });

  it("is embedded-gated with honest toggle speech", () => {
    expect(extractDeviceCommandForPlatform("开启环境观察", "embedded")).toMatchObject({ action: "vision.watch" });
    expect(extractDeviceCommandForPlatform("开启环境观察", "ios")).toBeNull();
    expect(deviceSuccessSpeech({ action: "vision.watch", args: { on: true } })).toBe("已开启环境观察。");
    expect(deviceSuccessSpeech({ action: "vision.watch", args: { on: false } })).toBe("已关闭环境观察。");
  });

  it("carries watchOn through PendingDeviceCommands", () => {
    const pending = new PendingDeviceCommands();
    const issued = pending.issue("vision.watch", "已开启环境观察。", Date.now(), undefined, true);
    expect(pending.peek(issued.commandId)?.watchOn).toBe(true);
  });
});
