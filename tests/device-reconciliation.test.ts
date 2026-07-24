import { describe, expect, it } from "vitest";
import { reconcileDeviceResult } from "../server/device-actions";

describe("reconcileDeviceResult", () => {
  it("stays silent on success when the action has no deterministic confirmation", () => {
    // Navigation and dialing speak their own confirmation (client card / system
    // dialer), so the relay stays silent for them.
    expect(reconcileDeviceResult("navigation.start", { status: "ok" })).toEqual({ truncate: false, speech: undefined });
  });

  it("speaks a deterministic confirmation and cuts the model on success", () => {
    // The rider must hear the truth about the action, not the model's chatter or
    // a mistaken safety refusal.
    expect(reconcileDeviceResult("camera.photo", { status: "ok" }, "拍好了。")).toEqual({
      truncate: true,
      speech: "拍好了。"
    });
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

  it("corrects an expired command by naming the action", () => {
    expect(reconcileDeviceResult("torch.set", { status: "failed", reason: "timeout" })).toEqual({
      truncate: true,
      speech: "手电筒操作没成功。"
    });
  });
});
