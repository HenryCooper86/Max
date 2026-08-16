// tests/amap-consent.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { amapConsentStorageKey, loadAmapConsent, saveAmapConsent, shouldMountAmapMap } from "../src/lib/amap-consent";

// The Amap JS SDK is fetched from webapi.amap.com and is handed the rider's
// route and position. Nothing may reach it before the rider agrees, and — this
// is where the web deliberately diverges from iOS's device-global
// UserDefaults — one rider's agreement must not answer for another's on a
// shared browser. persistence.ts already learned that lesson with the v1
// transcript key; consent has the same shape.

const RIDER_A = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const RIDER_B = "9c858901-8a57-4791-81fe-4c455b099bc9";

function installLocalStorage() {
  const store = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key)
    }
  };
  return store;
}

describe("amap consent storage", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = installLocalStorage();
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("defaults to unknown so the map stays off until asked", () => {
    expect(loadAmapConsent(RIDER_A)).toBe("unknown");
  });

  it("remembers a decision for the rider who made it", () => {
    saveAmapConsent(RIDER_A, "accepted");

    expect(loadAmapConsent(RIDER_A)).toBe("accepted");
  });

  it("keeps a decline distinct from never having been asked", () => {
    saveAmapConsent(RIDER_A, "declined");

    expect(loadAmapConsent(RIDER_A)).toBe("declined");
  });

  /// The reason this is account-scoped at all.
  it("does not let one rider's consent answer for another on the same browser", () => {
    saveAmapConsent(RIDER_A, "accepted");

    expect(loadAmapConsent(RIDER_B)).toBe("unknown");
  });

  it("scopes the key by account, like the v2 transcript", () => {
    expect(amapConsentStorageKey(RIDER_A)).toBe(`max.amapConsent.v1.${RIDER_A}`);
    expect(amapConsentStorageKey(RIDER_A.toUpperCase())).toBe(`max.amapConsent.v1.${RIDER_A}`);
  });

  it("refuses to key anything off a signed-out or malformed account", () => {
    expect(amapConsentStorageKey(null)).toBeNull();
    expect(amapConsentStorageKey("")).toBeNull();
    expect(amapConsentStorageKey("not-a-uuid")).toBeNull();
  });

  // Fail closed: with nobody to attribute the decision to, never persist and
  // never report consent.
  it("reads unknown and writes nothing when there is no valid account", () => {
    saveAmapConsent(null, "accepted");

    expect(store.size).toBe(0);
    expect(loadAmapConsent(null)).toBe("unknown");
  });

  it("treats a corrupt stored value as never asked", () => {
    store.set(`max.amapConsent.v1.${RIDER_A}`, JSON.stringify({ sneaky: true }));

    expect(loadAmapConsent(RIDER_A)).toBe("unknown");
  });
});

describe("shouldMountAmapMap", () => {
  // The gate has to sit above the script injection, not around the rendered
  // element: mounting is what pulls webapi.amap.com.
  it("mounts only with both a key and an accepted decision", () => {
    expect(shouldMountAmapMap("js-key", "accepted")).toBe(true);
  });

  it("stays off before the rider has been asked", () => {
    expect(shouldMountAmapMap("js-key", "unknown")).toBe(false);
  });

  it("stays off when the rider declined", () => {
    expect(shouldMountAmapMap("js-key", "declined")).toBe(false);
  });

  it("stays off with no configured key, however consent reads", () => {
    expect(shouldMountAmapMap(null, "accepted")).toBe(false);
    expect(shouldMountAmapMap("", "accepted")).toBe(false);
  });
});
