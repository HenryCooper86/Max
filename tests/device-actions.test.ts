import { describe, expect, it } from "vitest";
import {
  DEVICE_ACTION_TIERS,
  DEVICE_RESULT_TIMEOUT_MS,
  PendingDeviceCommands,
  deviceFailureSpeech,
  deviceSuccessSpeech,
  extractDeviceCommand
} from "../server/device-actions";

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

  it("opens the gallery", () => {
    expect(extractDeviceCommand("Max 打开相册")).toEqual({ action: "gallery.open", args: {} });
    expect(extractDeviceCommand("Max open the gallery")).toEqual({ action: "gallery.open", args: {} });
  });

  it("respects negation and non-commands", () => {
    expect(extractDeviceCommand("Max 别拍照")).toBeNull();
    expect(extractDeviceCommand("Max 我们刚才拍的照片在哪")).toBeNull();
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
  it("marks only messaging and calling as high risk", () => {
    expect(DEVICE_ACTION_TIERS).toEqual({
      "torch.set": "low",
      "volume.set": "low",
      "music.control": "low",
      "sms.compose": "high",
      "call.dial": "high",
      "destination.show": "low",
      "camera.photo": "low",
      "camera.record": "low",
      "gallery.open": "low",
      "navigation.start": "low",
      "navigation.stop": "low"
    });
  });
});
