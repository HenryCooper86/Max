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
 * every turn. Each addressed rider turn slides the window forward — but never
 * past WAKE_FOLLOWUP_MAX_CHAIN_MS after the last explicit "Max": without that
 * cap, continuous speech (passenger chatter, intercom) that produced a turn at
 * least every 12 s kept the agent answering everyone indefinitely.
 */
export const WAKE_FOLLOWUP_WINDOW_MS = 12_000;

/**
 * Hard ceiling on how long a follow-up chain may extend past the last explicit
 * wake phrase. A genuine conversation re-says "Max" once a minute at most; a
 * false wake (or overheard chatter) is cut off here.
 */
export const WAKE_FOLLOWUP_MAX_CHAIN_MS = 60_000;

// Optional greeting tokens that may precede the name (English + common Chinese),
// and name variants covering frequent ASR mishearings of "Max". The Chinese
// renderings are kept separate: Chinese ASR output has no spaces, so they must
// match inside a Han run ("麦克斯今天天气") where a token boundary never appears.
const GREETINGS = ["hey", "hi", "hiya", "hello", "yo", "ok", "okay", "嘿", "嗨", "喂", "你好", "哈喽", "哈罗"];
// "maxwell"/"maximus" are deliberately excluded: they are full, distinct words
// (Maxwell's equations, Maximus), not short ASR mishearings of "Max", and would
// false-wake on ordinary speech — mirroring the CJK exclusion of 麦克斯韦.
const LATIN_NAME_VARIANTS = ["max", "maxx", "maxs", "macks", "mack", "marks", "mac", "mags"];
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
// boundaries. Known false friends that embed a variant inside an unrelated
// common word are blanked out first: 马克思 in 马克思主义 (Marxism) and 麦克斯
// in 麦克斯韦 (Maxwell, as in the physicist/equations).
const CJK_WAKE_REGEX = new RegExp(CJK_NAME_VARIANTS.join("|"), "u");
const CJK_FALSE_FRIENDS = /马克思主义|麦克斯韦/gu;

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
  return LATIN_WAKE_REGEX.test(normalized) || CJK_WAKE_REGEX.test(normalized.replace(CJK_FALSE_FRIENDS, " "));
}
