// Wake-word detection for addressing the agent by name. The agent answers to
// "Max" — saying the name anywhere in an utterance addresses it (an optional
// greeting like "hey"/"你好" is allowed but not required, since ASR often drops
// it). Detection runs server-side on the rider ASR transcript — the live Doubao
// path can't pre-filter raw audio because ASR happens inside Doubao.

/** What the rider says to address the agent. Shown in HUD hints. */
export const WAKE_PHRASE_LABEL = "Max";

/**
 * After the rider addresses Max, follow-up utterances within this window count
 * as addressed too, so a back-and-forth conversation doesn't need the phrase on
 * every turn. Each addressed rider turn slides the window forward.
 */
export const WAKE_FOLLOWUP_WINDOW_MS = 12_000;

// Optional greeting tokens that may precede the name (English + common Chinese),
// and name variants covering frequent ASR mishearings of "Max".
const GREETINGS = ["hey", "hi", "hiya", "hello", "yo", "ok", "okay", "嘿", "嗨", "喂", "你好", "哈喽", "哈罗"];
const NAME_VARIANTS = ["max", "maxx", "maxs", "macks", "mack", "marks", "mac", "mags", "maximus", "maxwell", "麦克斯", "马克斯", "马克思", "迈克斯", "麦克思"];

// A name variant as a standalone token, with an optional greeting in front. The
// leading (?:^|\s) and trailing (?=\s|$) keep the match to a whole token, so the
// name embedded in a larger word ("maximum", "maximize") does not trigger, while
// a bare "Max" anywhere in the utterance does.
const WAKE_REGEX = new RegExp(
  `(?:^|\\s)(?:(?:${GREETINGS.join("|")})\\s*)?(?:${NAME_VARIANTS.join("|")})(?=\\s|$)`,
  "u"
);

/** Lowercase and turn every non-letter/digit run into a single space. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** True when `text` (a rider transcript) addresses the agent by name ("Max"). */
export function containsWakePhrase(text: string): boolean {
  if (!text) return false;
  return WAKE_REGEX.test(normalize(text));
}
