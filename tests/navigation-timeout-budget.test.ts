// tests/navigation-timeout-budget.test.ts
import { describe, expect, it } from "vitest";
import { DEVICE_RESULT_TIMEOUT_MS, NAVIGATION_RESULT_TIMEOUT_MS } from "../server/device-actions";

// The relay's navigation deadline is a safety net: it is what lets Max speak
// when a device goes silent. It must therefore outlast the slowest honest
// device attempt, or the relay speaks a failure while the phone is still
// working — which is what made a slow GPS fix sound like a routing failure.
//
// These are a documented, hand-maintained MIRROR of the client bounds below —
// not a live read of them (this is a TypeScript file; it cannot import
// Swift/Kotlin constants). Raising one of those bounds trips NOTHING here by
// itself: this test only fails if someone also forgets to raise
// NAVIGATION_RESULT_TIMEOUT_MS while leaving these constants unchanged. When
// you change a client bound, update BOTH sides by hand:
//   ios/MaxHelmet/Navigation/NavigationController.swift  firstFixTimeoutSeconds
//   android/.../navigation/NavigationController.kt        firstFixTimeoutMillis
//   ios/MaxHelmet/Navigation/RelayNavigationSearch.swift  timeoutSeconds
const CLIENT_FIRST_FIX_MS = 30_000;
const CLIENT_SEARCH_MS = 7_000;
const CLIENT_WORST_CASE_MS = CLIENT_FIRST_FIX_MS + CLIENT_SEARCH_MS + 60_000;

describe("navigation device-result deadline", () => {
  it("outlasts the slowest honest client attempt", () => {
    expect(NAVIGATION_RESULT_TIMEOUT_MS).toBeGreaterThan(CLIENT_WORST_CASE_MS);
  });

  it("keeps a margin rather than sitting exactly on the client bound", () => {
    expect(NAVIGATION_RESULT_TIMEOUT_MS - CLIENT_WORST_CASE_MS).toBeGreaterThanOrEqual(1_000);
  });

  it("stays longer than the ordinary device deadline", () => {
    expect(NAVIGATION_RESULT_TIMEOUT_MS).toBeGreaterThan(DEVICE_RESULT_TIMEOUT_MS);
  });
});
