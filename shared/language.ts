// Language helper for the browser client. Max speaks Chinese by default and
// also handles Japanese and English; this picks a matching TTS voice.

export type SupportedLanguage = "zh" | "ja" | "en";

/**
 * Best-effort detection of which supported language `text` is written in, used
 * to pick a matching text-to-speech voice. Hiragana or Katakana means
 * Japanese; otherwise any Han means Chinese; otherwise English. Kanji-only
 * text is treated as Chinese, since conversational Japanese almost always
 * includes kana.
 */
export function detectLanguage(text: string): SupportedLanguage {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return "ja";
  if (/[\p{Script=Han}]/u.test(text)) return "zh";
  return "en";
}
