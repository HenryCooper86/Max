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
// and name variants covering frequent ASR mishearings of "Max". The Chinese
// renderings are kept separate: Chinese ASR output has no spaces, so they must
// match inside a Han run ("麦克斯今天天气") where a token boundary never appears.
const GREETINGS = ["hey", "hi", "hiya", "hello", "yo", "ok", "okay", "嘿", "嗨", "喂", "你好", "哈喽", "哈罗"];
const LATIN_NAME_VARIANTS = ["max", "maxx", "maxs", "macks", "mack", "marks", "mac", "mags", "maximus", "maxwell"];
const CJK_NAME_VARIANTS = ["麦克斯", "马克斯", "马克思", "迈克斯", "麦克思"];

// A Latin name variant as a standalone token, with an optional greeting in
// front. The leading (?:^|\s) and trailing (?=\s|$) keep the match to a whole
// token, so the name embedded in a larger word ("maximum", "maximize") does not
// trigger, while a bare "Max" anywhere in the utterance does. Normalization
// inserts spaces at Han↔Latin boundaries, so "max今天" still matches.
const LATIN_WAKE_REGEX = new RegExp(
  `(?:^|\\s)(?:(?:${GREETINGS.join("|")})\\s*)?(?:${LATIN_NAME_VARIANTS.join("|")})(?=\\s|$)`,
  "u"
);

// Chinese renderings of the name match anywhere — Han text has no token
// boundaries, and none of these appear embedded in common words.
const CJK_WAKE_REGEX = new RegExp(CJK_NAME_VARIANTS.join("|"), "u");

/**
 * NFKC-fold (so fullwidth "Ｍａｘ" and CJK punctuation variants compare equal),
 * lowercase, turn every non-letter/digit run into a single space, and add a
 * space at Han↔Latin boundaries so a name glued to Chinese text still tokenizes.
 */
function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/(\p{Script=Han})(?=[a-z0-9])/gu, "$1 ")
    .replace(/([a-z0-9])(?=\p{Script=Han})/gu, "$1 ")
    .trim();
}

/** True when `text` (a rider transcript) addresses the agent by name ("Max"). */
export function containsWakePhrase(text: string): boolean {
  if (!text) return false;
  const normalized = normalize(text);
  return LATIN_WAKE_REGEX.test(normalized) || CJK_WAKE_REGEX.test(normalized);
}
