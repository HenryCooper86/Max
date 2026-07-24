import { describe, expect, it } from "vitest";
import { DEVICE_ACTION_TIERS, extractDeviceCommand } from "../server/device-actions";

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
    expect(extractDeviceCommand("Max pause the music")).toEqual({ action: "music.control", args: { control: "pause" } });
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

describe("extractDeviceCommand — destination", () => {
  it("extracts the destination query", () => {
    expect(extractDeviceCommand("Max 导航去天安门")).toEqual({
      action: "destination.show",
      args: { query: "天安门" }
    });
    expect(extractDeviceCommand("Max navigate to the airport")).toEqual({
      action: "destination.show",
      args: { query: "the airport" }
    });
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

describe("DEVICE_ACTION_TIERS", () => {
  it("marks only messaging and calling as high risk", () => {
    expect(DEVICE_ACTION_TIERS).toEqual({
      "torch.set": "low",
      "volume.set": "low",
      "music.control": "low",
      "sms.compose": "high",
      "call.dial": "high",
      "destination.show": "low"
    });
  });
});
