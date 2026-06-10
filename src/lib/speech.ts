// Browser speech-synthesis voice selection for the TTS fallback path.

import type { SupportedLanguage } from "../../shared/language";
import type { VoiceGender } from "../types";

// BCP-47 locales per supported language, used for the browser-TTS fallback.
export const VOICE_LOCALE: Record<SupportedLanguage, string> = {
  zh: "zh-CN",
  en: "en-US"
};

// Voice-name hints per gender and language. `\bmale\b` avoids matching "female".
const VOICE_HINTS: Record<VoiceGender, Record<SupportedLanguage, RegExp>> = {
  female: {
    zh: /female|女|xiaoxiao|xiaoyi|ting-?ting|jupiter/i,
    en: /female|samantha|victoria|zira|aria|jenny|fiona/i
  },
  male: {
    zh: /\bmale\b|男|kangkang|yunyang|yunxi|yunjian|liang/i,
    en: /\bmale\b|daniel|alex|david|mark|guy|fred|thomas/i
  }
};

/**
 * Picks a voice for the language and gender. Returns `matched: false` when no
 * genuinely gendered voice is installed, so the caller can compensate via pitch.
 */
export function selectVoice(language: SupportedLanguage, gender: VoiceGender) {
  const voices = window.speechSynthesis.getVoices();
  const matches = voices.filter((voice) => voice.lang.toLowerCase().startsWith(language));
  const describe = (voice: SpeechSynthesisVoice) => `${voice.name} ${voice.voiceURI}`;

  const exact = matches.find((voice) => VOICE_HINTS[gender][language].test(describe(voice)));
  if (exact) return { voice: exact, matched: true };

  // No gendered voice for this language: skip the opposite gender's obvious
  // voice if we can, but still return something so the reply is spoken.
  const opposite = VOICE_HINTS[gender === "male" ? "female" : "male"][language];
  const neutral = matches.find((voice) => !opposite.test(describe(voice)));
  return { voice: neutral ?? matches[0], matched: false };
}
