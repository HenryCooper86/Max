import { describe, expect, it } from "vitest";
import { inferTestingPlatform } from "../server/testing-store";
import { deviceFailureSpeech } from "../server/device-actions";
import { parseClientEvent } from "../server/session-controller";
import { REQUIRED_TESTING_PLATFORMS, TESTING_PLATFORMS } from "../shared/testing";

describe("embedded platform", () => {
  it("accepts an explicit embedded platform", () => {
    expect(inferTestingPlatform("embedded")).toBe("embedded");
  });

  it("infers embedded from an RDK device label", () => {
    expect(inferTestingPlatform(undefined, "RDK X5")).toBe("embedded");
  });

  it("still infers the existing platforms", () => {
    expect(inferTestingPlatform("web")).toBe("web");
    expect(inferTestingPlatform(undefined, "iPhone 15")).toBe("ios");
    expect(inferTestingPlatform(undefined, "Pixel 8 android")).toBe("android");
    expect(inferTestingPlatform(undefined, "nothing useful")).toBe("unknown");
  });

  it("does not add embedded to the release-gate platforms", () => {
    expect(REQUIRED_TESTING_PLATFORMS).toEqual(["web", "ios", "android"]);
  });
});

describe("session.start platform acceptance", () => {
  function sessionStart(platform: string) {
    return JSON.stringify({ type: "session.start", sampleRate: 16000, channels: 1, platform });
  }

  it("accepts an embedded session.start", () => {
    // The relay rejected the board's very first real session with "Invalid
    // platform": server/session-controller.ts kept its own hardcoded allowlist,
    // a fifth copy of the platform list that the enum change did not reach.
    const event = parseClientEvent(sessionStart("embedded"));
    expect(event.type).toBe("session.start");
  });

  it("accepts every platform in the canonical list", () => {
    for (const platform of TESTING_PLATFORMS) {
      expect(() => parseClientEvent(sessionStart(platform))).not.toThrow();
    }
  });

  it("still rejects a platform that is not in the list", () => {
    expect(() => parseClientEvent(sessionStart("toaster"))).toThrow(/platform/i);
  });

  it("canonical list covers the release-gate platforms plus embedded", () => {
    for (const platform of [...REQUIRED_TESTING_PLATFORMS, "embedded", "unknown"]) {
      expect(TESTING_PLATFORMS).toContain(platform);
    }
  });
});

describe("embedded failure speech", () => {
  it("explains a missing screen without naming the gallery", () => {
    expect(deviceFailureSpeech("destination.show", "unsupported", "device.noScreen")).toBe("头盔上没有屏幕，看不了。");
  });

  it("explains missing phone features", () => {
    expect(deviceFailureSpeech("call.dial", "unsupported", "device.noPhone")).toBe(
      "头盔上没有手机功能，这个我做不了。"
    );
  });

  it("explains a not-yet-built feature", () => {
    expect(deviceFailureSpeech("navigation.start", "unsupported", "device.notYet")).toBe("这个功能头盔上还没上线。");
  });
});
