// Language helper for the browser client. Max speaks Chinese by default and
// also handles English; this picks a matching TTS voice.

export type SupportedLanguage = "zh" | "en";

/**
 * Best-effort detection of which supported language `text` is written in, used
 * to pick a matching text-to-speech voice. Any Han character means Chinese;
 * otherwise English. Only Chinese and English are supported.
 */
export function detectLanguage(text: string): SupportedLanguage {
  if (/[\p{Script=Han}]/u.test(text)) return "zh";
  return "en";
}
