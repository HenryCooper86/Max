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

export function navFabricationGuard(deps: NavFabricationGuardDeps) {
  let firedThisReply = false;

  return {
    /** Call at the start of each agent reply. */
    beginReply(): void {
      firedThisReply = false;
    },

    /** Returns true when this sentence was suppressed. */
    inspectSentence(text: string, itemId: string | undefined): boolean {
      if (!assertsNavigation(text)) return false;
      // Every sentence of a fabricated reply is suppressed, but the rider
      // hears the correction once — not once per sentence.
      if (!firedThisReply) {
        firedThisReply = true;
        deps.clearPendingAudio();
        deps.truncateReply();
        // Ordering is load-bearing here — see clearClientPlayback's doc comment.
        deps.clearClientPlayback();
        deps.speakHonestLine(deps.routeActive() ? ROUTE_ACTIVE_LINE : NO_ROUTE_LINE);
      }
      if (itemId) deps.suppressItem(itemId);
      return true;
    }
  };
}
