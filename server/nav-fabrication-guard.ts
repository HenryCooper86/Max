// Enforces the rule that navigation truth may originate only from the relay's
// nav.* speech. The detector decides; this decides what to do about it, kept
// out of the provider so it is testable without a socket.

import { assertsNavigation } from "../shared/nav-fabrication";

export const NO_ROUTE_LINE = "导航还没启动，我没法给你指路。";
export const ROUTE_ACTIVE_LINE = "请以导航提示为准。";

export type NavFabricationGuardDeps = {
  routeActive: () => boolean;
  /** Cut off a reply whose audio has already reached the rider. */
  truncateReply: () => void;
  /** Drop audio not yet forwarded. No-op when nothing is held. */
  clearPendingAudio: () => void;
  /** Tell the client to flush whatever audio it already has queued or
   *  playing. MUST be called, and MUST complete, before speakHonestLine:
   *  every real client's speech stack (web speechSynthesis.cancel(), iOS
   *  stopSpeaking(.immediate), Android tts.stop()) treats this same signal
   *  as "abort in-flight utterance" — calling it after speakHonestLine has
   *  already started the correction cancels the correction itself the
   *  instant it begins. */
  clearClientPlayback: () => void;
  speakHonestLine: (text: string) => void;
  /** Mark the upstream conversation item for deletion so the model does not
   *  build on its own fabrication. */
  suppressItem: (itemId: string) => void;
};

/**
 * Deliberately two-phase. A rider's turn is not always known to be addressed
 * to Max the moment a fabricated sentence arrives — the wake-word decision
 * can still be undecided (Doubao can answer before the rider's ASR hypothesis
 * has settled), and it can later resolve either way. Suppression
 * (inspectSentence) must never wait on that decision: the caller is expected
 * to call it unconditionally, the instant fabricated text is seen, so the
 * audio and text are never forwarded regardless of what the wake decision
 * turns out to be. The audible correction (announceIfDetected) is the
 * opposite: it must NOT fire until the caller has confirmed the reply is
 * actually addressed, since an unprompted correction on a reply the rider
 * never spoke to would itself be a new, unasked-for interruption. Collapsing
 * these into one call (as an earlier version of this guard did) forces a
 * false choice: gate everything on "addressed" and let undecided-window
 * fabrication escape suppression entirely, or announce everything
 * immediately and risk announcing on a turn that resolves unaddressed.
 */
export function navFabricationGuard(deps: NavFabricationGuardDeps) {
  let detectedThisReply = false;
  let announcedThisReply = false;

  return {
    /** Call at the start of each agent reply. */
    beginReply(): void {
      detectedThisReply = false;
      announcedThisReply = false;
    },

    /** Detects and suppresses fabricated navigation. Call unconditionally,
     *  regardless of whether the reply is known to be addressed yet — this is
     *  the half of the guard that must never wait on the wake decision.
     *  Returns true when this sentence was suppressed. */
    inspectSentence(text: string, itemId: string | undefined): boolean {
      if (!assertsNavigation(text)) return false;
      // Every sentence of a fabricated reply is suppressed, but the rider
      // hears the correction once — not once per sentence, and not until
      // announceIfDetected() below confirms the reply is addressed.
      if (!detectedThisReply) {
        detectedThisReply = true;
        deps.clearPendingAudio();
        deps.truncateReply();
      }
      if (itemId) deps.suppressItem(itemId);
      return true;
    },

    /** Speaks the honest correction — but only if this reply had fabrication
     *  detected (inspectSentence returned true at least once since the last
     *  beginReply), and only once per reply. Call it whenever the caller
     *  learns (or already knows) the reply is addressed: right after a
     *  same-call inspectSentence hit on an already-addressed reply, AND
     *  separately wherever an undecided reply's wake decision resolves to
     *  addressed — a reply can have no further TtsSentence/ChatResponse
     *  delta after that point, so the announcement cannot always wait for
     *  the next inspectSentence call. Safe to call speculatively and
     *  repeatedly; a no-op once nothing is pending or it already spoke. */
    announceIfDetected(): void {
      if (!detectedThisReply || announcedThisReply) return;
      announcedThisReply = true;
      // Ordering is load-bearing here — see clearClientPlayback's doc comment.
      deps.clearClientPlayback();
      deps.speakHonestLine(deps.routeActive() ? ROUTE_ACTIVE_LINE : NO_ROUTE_LINE);
    }
  };
}
