import { describe, expect, it } from "vitest";
import { reconcileDeviceResult } from "../server/device-actions";

describe("reconcileDeviceResult", () => {
  it("stays silent on success so Doubao's own confirmation stands", () => {
    expect(reconcileDeviceResult("torch.set", { status: "ok" })).toEqual({ truncate: false, speech: undefined });
  });

  it("truncates and corrects on failure", () => {
    expect(reconcileDeviceResult("sms.compose", { status: "denied", reason: "unsafe.speed" })).toEqual({
      truncate: true,
      speech: "骑行中我不发短信，停车以后我再帮你发。"
    });
  });

  it("prefers the device's own detail when it supplies one", () => {
    expect(reconcileDeviceResult("call.dial", { status: "failed", reason: "x", detail: "自定义说明" })).toEqual({
      truncate: true,
      speech: "自定义说明"
    });
  });

  it("corrects an expired command with the generic line", () => {
    expect(reconcileDeviceResult("torch.set", { status: "failed", reason: "timeout" })).toEqual({
      truncate: true,
      speech: "刚才那个操作没成功。"
    });
  });
});
