// Whether the rider has agreed to the Amap JS map, and whether it may load.
//
// The map is not a passive tile layer: the SDK is fetched from
// webapi.amap.com and is handed the rider's route and current position, so
// nothing may load before the rider agrees. iOS keeps this decision in
// UserDefaults, which is device-global — correct for a personal phone. The web
// HUD runs in shared browsers, where a device-global decision would let one
// rider's agreement answer for the next rider's data. persistence.ts already
// learned this with its v1 transcript key, so consent is account-scoped from
// the start and reuses that module's definition of a usable account id.
//
// Everything here fails closed: no account, unreadable storage, or a value
// this module did not write all read back as "unknown".

import { accountScopedKey } from "./persistence";

export type AmapConsentDecision = "unknown" | "accepted" | "declined";

const CONSENT_KEY_PREFIX = "max.amapConsent.v1.";

/** The storage key for this rider, or null when there is no account to attribute a decision to. */
export function amapConsentStorageKey(userId: string | null): string | null {
  return accountScopedKey(CONSENT_KEY_PREFIX, userId);
}

function isDecision(value: unknown): value is AmapConsentDecision {
  return value === "unknown" || value === "accepted" || value === "declined";
}

export function loadAmapConsent(userId: string | null): AmapConsentDecision {
  const key = amapConsentStorageKey(userId);
  if (!key) return "unknown";
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return "unknown";
    const parsed: unknown = JSON.parse(raw);
    return isDecision(parsed) ? parsed : "unknown";
  } catch {
    // Storage unavailable, or a value we did not write. Treat as never asked.
    return "unknown";
  }
}

export function saveAmapConsent(userId: string | null, decision: AmapConsentDecision): void {
  const key = amapConsentStorageKey(userId);
  if (!key) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(decision));
  } catch {
    /* storage unavailable or full — persistence is best-effort */
  }
}

/**
 * Gates the SDK itself, not the rendered element: mounting the map is what
 * injects the webapi.amap.com script, so this must be consulted before that
 * happens rather than merely hiding a map that already loaded.
 */
export function shouldMountAmapMap(key: string | null, decision: AmapConsentDecision): boolean {
  return Boolean(key) && decision === "accepted";
}
