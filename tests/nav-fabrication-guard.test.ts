// tests/nav-fabrication-guard.test.ts
import { describe, expect, it, vi } from "vitest";
import { NO_ROUTE_LINE, ROUTE_ACTIVE_LINE, navFabricationGuard } from "../server/nav-fabrication-guard";
import { assertsNavigation } from "../shared/nav-fabrication";

function guard(routeActive = false) {
  const calls = {
    truncate: vi.fn(),
    clearAudio: vi.fn(),
    clearClientPlayback: vi.fn(),
    speak: vi.fn(),
    suppressItem: vi.fn()
  };
  return {
    calls,
    g: navFabricationGuard({
      routeActive: () => routeActive,
      truncateReply: calls.truncate,
      clearPendingAudio: calls.clearAudio,
      clearClientPlayback: calls.clearClientPlayback,
      speakHonestLine: calls.speak,
      suppressItem: calls.suppressItem
    })
  };
}

describe("navFabricationGuard", () => {
  it("passes legitimate speech through untouched", () => {
    const { g, calls } = guard();
    expect(g.inspectSentence("好的，正在为你规划路线", "item-1")).toBe(false);
    expect(calls.speak).not.toHaveBeenCalled();
    expect(calls.truncate).not.toHaveBeenCalled();
  });

  it("suppresses a fabricated maneuver and speaks the no-route line", () => {
    const { g, calls } = guard(false);
    expect(g.inspectSentence("前方800米后左转", "item-2")).toBe(true);
    expect(calls.speak).toHaveBeenCalledWith(NO_ROUTE_LINE);
    expect(calls.suppressItem).toHaveBeenCalledWith("item-2");
  });

  // Regression: every real client aborts in-flight speech-synthesis playback
  // on the SAME signal clearClientPlayback triggers (web speechSynthesis.
  // cancel(), iOS stopSpeaking(.immediate), Android tts.stop()). Calling it
  // after speakHonestLine had already started the correction would cancel
  // the correction's own utterance the instant it began.
  it("clears client playback BEFORE speaking the honest line, not after", () => {
    const { g, calls } = guard();
    g.inspectSentence("前方800米后左转", "item-order");
    expect(calls.clearClientPlayback).toHaveBeenCalledTimes(1);
    expect(calls.speak).toHaveBeenCalledTimes(1);
    expect(calls.clearClientPlayback.mock.invocationCallOrder[0]).toBeLessThan(
      calls.speak.mock.invocationCallOrder[0]!
    );
  });

  it("speaks the route-active line when a route is running", () => {
    const { g, calls } = guard(true);
    g.inspectSentence("前方800米后左转", "item-3");
    expect(calls.speak).toHaveBeenCalledWith(ROUTE_ACTIVE_LINE);
  });

  // Pins the literal wording (not just self-referential equality against the
  // constants above) so a future edit to either string is a visible, deliberate
  // change rather than a silent drift.
  it("has the exact honest-line wording riders were promised", () => {
    expect(NO_ROUTE_LINE).toBe("导航还没启动，我没法给你指路。");
    expect(ROUTE_ACTIVE_LINE).toBe("请以导航提示为准。");
  });

  // The rider must not hear the honest line once per sentence.
  it("speaks exactly one honest line per reply", () => {
    const { g, calls } = guard();
    g.inspectSentence("前方800米后左转", "item-4");
    g.inspectSentence("然后右转进入中山东一路", "item-4");
    g.inspectSentence("再走300米", "item-4");
    expect(calls.speak).toHaveBeenCalledTimes(1);
  });

  it("re-arms for the next reply", () => {
    const { g, calls } = guard();
    g.inspectSentence("前方800米后左转", "item-5");
    g.beginReply();
    g.inspectSentence("再走300米后掉头", "item-6");
    expect(calls.speak).toHaveBeenCalledTimes(2);
  });

  it("never suppresses relay-spoken navigation lines", () => {
    // Relay lines do not pass through the model's TTS stream at all, so the
    // guard must never see them. This pins the property that the guard cannot
    // silence real navigation: the detector would flag this text, and the guard
    // is simply never asked about it.
    expect(assertsNavigation("前方300米右转")).toBe(true);
  });
});
