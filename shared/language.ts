// Language gating shared by the browser client and the Express server.
// Max only handles Chinese, Japanese, and English; anything else is refused.

/** Reply shown when the rider uses an unsupported language. */
export const SUPPORTED_LANGUAGE_MESSAGE = "我只支持中文、English、日本語。请使用这三种语言之一。";

/**
 * Returns true when `text` contains only characters from supported scripts
 * (Han, Hiragana, Katakana, Latin) plus numbers, punctuation, separators, and
 * symbols. Text made up entirely of those characters is considered supported.
 */
export function isSupportedLanguageText(text: string): boolean {
  const unsupported = text
    .replace(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Latin}\p{Number}\p{Punctuation}\p{Separator}\p{Symbol}]/gu,
      ""
    )
    .trim();
  return unsupported.length === 0;
}
