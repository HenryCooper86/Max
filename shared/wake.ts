// Wake-word detection for addressing the agent by name. The agent answers to
// "Max" — saying the name anywhere in an utterance addresses it (an optional
// greeting like "hey"/"你好" is allowed but not required, since ASR often drops
// it). Detection runs server-side on the rider ASR transcript — the live Doubao
// path can't pre-filter raw audio because ASR happens inside Doubao.

/** What the rider says to address the agent. Shown in HUD hints. This is the
 *  built-in default; a relay with its own assistant profile reports the real
 *  phrase through `/health` (AgentHealth.assistant.wakePhrase). */
const WAKE_PHRASE_LABEL = "Max";

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

// Optional greeting tokens that may precede the name (English + common Chinese).
const GREETINGS = ["hey", "hi", "hiya", "hello", "yo", "ok", "okay", "嘿", "嗨", "喂", "你好", "哈喽", "哈罗"];

/** The names an assistant answers to, split by how they have to be matched. */
export type WakeNames = {
  /** Shown to the wearer ("say Max"). */
  label: string;
  /** Latin-script names and their frequent ASR mishearings, lowercase. Matched
   *  as whole tokens. */
  latin: string[];
  /** Han renderings of the name. Matched anywhere: Chinese ASR output has no
   *  spaces, so a token boundary never appears ("麦克斯今天天气"). */
  cjk: string[];
  /** Common words that embed a `cjk` variant and must not wake the agent. */
  falseFriends: string[];
};

// Name variants covering frequent ASR mishearings of "Max".
// "maxwell"/"maximus" are deliberately excluded: they are full, distinct words
// (Maxwell's equations, Maximus), not short ASR mishearings of "Max", and would
// false-wake on ordinary speech — mirroring the CJK exclusion of 麦克斯韦.
// Known CJK false friends embed a variant inside an unrelated common word:
// 马克思 in 马克思主义 (Marxism) and 麦克斯 in 麦克斯韦 (Maxwell, the physicist).
export const DEFAULT_WAKE_NAMES: WakeNames = {
  label: WAKE_PHRASE_LABEL,
  latin: ["max", "maxx", "maxs", "macks", "mack", "marks", "mac", "mags"],
  cjk: ["麦克斯", "马克斯", "马克思", "迈克斯", "麦克思"],
  falseFriends: ["马克思主义", "麦克斯韦"]
};

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

/** Builds a matcher for one set of names. */
export function createWakeMatcher(names: WakeNames): (text: string) => boolean {
  // Multi-word Latin names ("hey computer") are normalized the same way the
  // transcript is, so they compare token for token.
  const latin = names.latin.map(normalize).filter(Boolean).map(escapeRegex);
  const cjk = names.cjk
    .map((name) => name.normalize("NFKC"))
    .filter(Boolean)
    .map(escapeRegex);
  const falseFriends = names.falseFriends
    .map((word) => word.normalize("NFKC"))
    .filter(Boolean)
    .map(escapeRegex);
  // A Latin name variant as a standalone token, with an optional greeting in
  // front. The leading (?:^|\s) and trailing (?=\s|$) keep the match to a
  // whole token, so the name embedded in a larger word ("maximum") does not
  // trigger, while a bare name anywhere in the utterance does. Normalization
  // inserts spaces at Han↔Latin boundaries, so "max今天" still matches.
  const latinRegex = latin.length
    ? new RegExp(`(?:^|\\s)(?:(?:${GREETINGS.join("|")})\\s*)?(?:${latin.join("|")})(?=\\s|$)`, "u")
    : undefined;
  const cjkRegex = cjk.length ? new RegExp(cjk.join("|"), "u") : undefined;
  const falseFriendRegex = falseFriends.length ? new RegExp(falseFriends.join("|"), "gu") : undefined;

  return (text) => {
    if (!text) return false;
    const normalized = normalize(text);
    if (latinRegex?.test(normalized)) return true;
    if (!cjkRegex) return false;
    return cjkRegex.test(falseFriendRegex ? normalized.replace(falseFriendRegex, " ") : normalized);
  };
}

let activeMatcher = createWakeMatcher(DEFAULT_WAKE_NAMES);

/** Installs the names the relay's assistant answers to (server/assistant.ts). */
export function configureWakePhrase(names: WakeNames): void {
  activeMatcher = createWakeMatcher(names);
}

/** True when `text` (a rider transcript) addresses the agent by name. */
export function containsWakePhrase(text: string): boolean {
  return activeMatcher(text);
}
