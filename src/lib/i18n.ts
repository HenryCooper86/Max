export type Language = "zh-CN" | "en-US";

export const DEFAULT_LANGUAGE: Language = "zh-CN";
export const LANGUAGE_STORAGE_KEY = "max.ui.language.v1";

const DICTIONARIES = {
  "zh-CN": {
    "settings.title": "设置",
    "login.welcome": "欢迎使用 {product}",
    "language.chinese": "中文",
    "language.english": "EN",
    "language.label": "界面语言",
    "language.englishAria": "切换到英文",
    "language.chineseAria": "切换到中文"
  },
  "en-US": {
    "settings.title": "Settings",
    "login.welcome": "Welcome to {product}",
    "language.chinese": "中文",
    "language.english": "EN",
    "language.label": "Interface language",
    "language.englishAria": "Switch to English",
    "language.chineseAria": "Switch to Chinese"
  }
} as const;

export type TranslationKey = keyof (typeof DICTIONARIES)["zh-CN"];
export type Translator = (key: TranslationKey, params?: Record<string, string | number>) => string;

export function readStoredLanguage(storage: Storage | undefined = typeof window === "undefined" ? undefined : window.localStorage): Language {
  try {
    const value = storage?.getItem(LANGUAGE_STORAGE_KEY);
    return value === "en-US" || value === "zh-CN" ? value : DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

export function createTranslator(language: Language): Translator {
  return (key, params = {}) => {
    const template = DICTIONARIES[language][key] ?? DICTIONARIES[DEFAULT_LANGUAGE][key];
    return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
  };
}

export function persistLanguage(language: Language, storage: Storage | undefined = typeof window === "undefined" ? undefined : window.localStorage) {
  try {
    storage?.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // UI preference persistence is best effort; the active language still applies.
  }
}
