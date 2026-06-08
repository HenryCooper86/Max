// Wake-phrase detection for addressing the agent by name. The agent is "Max",
// but a bare single-syllable name is unreliable (ASR mishears it and it false-
// triggers on words like "match" / "max speed"), so it answers to the phrase
// "Hey Max". Detection runs server-side on the rider ASR transcript — the live
// Doubao path can't pre-filter raw audio because ASR happens inside Doubao.

/** What the rider says to address the agent. Shown in HUD hints. */
export const WAKE_PHRASE_LABEL = "Hey Max";

/**
 * After the rider addresses Max, follow-up utterances within this window count
 * as addressed too, so a back-and-forth conversation doesn't need the phrase on
 * every turn. Each addressed rider turn slides the window forward.
 */
export const WAKE_FOLLOWUP_WINDOW_MS = 12_000;

// Greeting tokens that may precede the name (English + common Chinese), and
// name variants covering frequent ASR mishearings of "Max".
const GREETINGS = ["hey", "hi", "hiya", "hello", "yo", "ok", "okay", "嘿", "嗨", "喂", "你好", "哈喽", "哈罗"];
const NAME_VARIANTS = ["max", "maxx", "maxs", "macks", "mack", "marks", "mac", "mags", "maximus", "maxwell", "麦克斯", "马克斯"];

// Greeting at a token boundary, optional space, then a name variant ending the
// token. The leading (?:^|\s) stops "they max out" from matching the "hey max"
// substring; the trailing (?=\s|$) stops "hey maximum" from matching on "max".
const WAKE_REGEX = new RegExp(
  `(?:^|\\s)(?:${GREETINGS.join("|")})\\s*(?:${NAME_VARIANTS.join("|")})(?=\\s|$)`,
  "u"
);

/** Lowercase and turn every non-letter/digit run into a single space. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** True when `text` (a rider transcript) addresses the agent as "Hey Max". */
export function containsWakePhrase(text: string): boolean {
  if (!text) return false;
  return WAKE_REGEX.test(normalize(text));
}
