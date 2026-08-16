// Shares one Amap consent decision between the navigation panel (which shows
// the prompt where the map would be) and the settings sheet (which holds the
// full disclosure and lets a rider change their mind). Two independent copies
// of this state would let the sheet and the panel disagree about whether the
// SDK is allowed to load.

import { useCallback, useEffect, useMemo, useState } from "react";
import { loadAmapConsent, saveAmapConsent } from "../lib/amap-consent";
import type { AmapConsentDecision } from "../lib/amap-consent";

export type AmapConsentControls = {
  decision: AmapConsentDecision;
  accept: () => void;
  decline: () => void;
};

export function useAmapConsent(userId: string | null): AmapConsentControls {
  const [decision, setDecision] = useState<AmapConsentDecision>("unknown");

  // Re-read on every account change: signing in as someone else must not
  // inherit the previous rider's answer, and signing out must fall back to
  // "unknown" so the map stops loading.
  useEffect(() => {
    if (typeof window === "undefined") {
      setDecision("unknown");
      return;
    }
    setDecision(loadAmapConsent(userId));
  }, [userId]);

  const decide = useCallback(
    (next: AmapConsentDecision) => {
      saveAmapConsent(userId, next);
      setDecision(next);
    },
    [userId]
  );

  return useMemo(
    () => ({
      decision,
      accept: () => decide("accepted"),
      decline: () => decide("declined")
    }),
    [decision, decide]
  );
}
