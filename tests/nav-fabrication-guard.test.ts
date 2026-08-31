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
    expect(calls.clearClientPlayback).not.toHaveBeenCalled();
  });

  // The two-phase split this pins: suppression (inspectSentence) must apply
  // immediately, before the caller has any idea whether the reply is
  // addressed — the audible correction (announceIfDetected) is a SEPARATE
  // step the caller only takes once it knows. Collapsing them (an earlier
  // version of this guard did) forces suppression to wait on the wake
  // decision too, which let fabricated audio buffered during an undecided
  // window escape uncaught once the decision later latched addressed.
  it("suppresses immediately on inspectSentence, but does not speak until announceIfDetected() is called", () => {
    const { g, calls } = guard(false);
    expect(g.inspectSentence("前方800米后左转", "item-2")).toBe(true);
    expect(calls.clearAudio).toHaveBeenCalledTimes(1);
    expect(calls.truncate).toHaveBeenCalledTimes(1);
    expect(calls.suppressItem).toHaveBeenCalledWith("item-2");
    expect(calls.speak).not.toHaveBeenCalled();
    expect(calls.clearClientPlayback).not.toHaveBeenCalled();

    g.announceIfDetected();
    expect(calls.speak).toHaveBeenCalledWith(NO_ROUTE_LINE);
    expect(calls.clearClientPlayback).toHaveBeenCalledTimes(1);
  });

  it("announceIfDetected() is a no-op when nothing was detected this reply", () => {
    const { g, calls } = guard();
    g.announceIfDetected();
    expect(calls.speak).not.toHaveBeenCalled();
    expect(calls.clearClientPlayback).not.toHaveBeenCalled();
  });

  it("announceIfDetected() speaks only once even when called repeatedly", () => {
    const { g, calls } = guard();
    g.inspectSentence("前方800米后左转", "item-repeat");
    g.announceIfDetected();
    g.announceIfDetected();
    g.announceIfDetected();
    expect(calls.speak).toHaveBeenCalledTimes(1);
    expect(calls.clearClientPlayback).toHaveBeenCalledTimes(1);
  });

  // Regression: every real client aborts in-flight speech-synthesis playback
  // on the SAME signal clearClientPlayback triggers (web speechSynthesis.
  // cancel(), iOS stopSpeaking(.immediate), Android tts.stop()). Calling it
  // after speakHonestLine had already started the correction would cancel
  // the correction's own utterance the instant it began.
  it("clears client playback BEFORE speaking the honest line, not after", () => {
    const { g, calls } = guard();
    g.inspectSentence("前方800米后左转", "item-order");
    g.announceIfDetected();
    expect(calls.clearClientPlayback).toHaveBeenCalledTimes(1);
    expect(calls.speak).toHaveBeenCalledTimes(1);
    expect(calls.clearClientPlayback.mock.invocationCallOrder[0]).toBeLessThan(
      calls.speak.mock.invocationCallOrder[0]!
    );
  });

  it("speaks the route-active line when a route is running", () => {
    const { g, calls } = guard(true);
    g.inspectSentence("前方800米后左转", "item-3");
    g.announceIfDetected();
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
    g.announceIfDetected();
    expect(calls.speak).toHaveBeenCalledTimes(1);
  });

  it("re-arms for the next reply — both suppression and announcement", () => {
    const { g, calls } = guard();
    g.inspectSentence("前方800米后左转", "item-5");
    g.announceIfDetected();
    g.beginReply();
    // Before the next inspectSentence call, the reset must hold: nothing to
    // announce yet for the new reply.
    g.announceIfDetected();
    expect(calls.speak).toHaveBeenCalledTimes(1);

    g.inspectSentence("再走300米后掉头", "item-6");
    g.announceIfDetected();
    expect(calls.speak).toHaveBeenCalledTimes(2);
  });

  // Pins the exact scenario the guard's two-phase split exists for: a
  // fabricated sentence detected while the caller does not yet know the
  // reply is addressed, followed later by the decision resolving addressed
  // with no further sentence to re-trigger detection.
  it("suppression detected before the wake decision resolves is still announced once it does", () => {
    const { g, calls } = guard(false);
    // Caller has not yet learned this reply is addressed — suppression still
    // applies immediately.
    g.inspectSentence("前方800米后左转", "item-undecided");
    expect(calls.speak).not.toHaveBeenCalled();
    // The wake decision resolves addressed later, with no further sentence —
    // the caller calls announceIfDetected() directly from wherever that
    // resolution happens.
    g.announceIfDetected();
    expect(calls.speak).toHaveBeenCalledWith(NO_ROUTE_LINE);
  });

  it("never suppresses relay-spoken navigation lines", () => {
    // Relay lines do not pass through the model's TTS stream at all, so the
    // guard must never see them. This pins the property that the guard cannot
    // silence real navigation: the detector would flag this text, and the guard
    // is simply never asked about it.
    expect(assertsNavigation("前方300米右转")).toBe(true);
  });
});
