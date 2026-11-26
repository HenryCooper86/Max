import { createContext, useContext, useEffect, useMemo, useState, type PropsWithChildren } from "react";
import {
  applyDocumentLanguage,
  createTranslator,
  persistLanguage,
  readStoredLanguage,
  type Language,
  type Translator
} from "../lib/i18n";

type LanguageContextValue = {
  language: Language;
  setLanguage: (language: Language) => void;
  t: Translator;
};

const LanguageContext = createContext<LanguageContextValue | null>(null);

export function LanguageProvider({ children }: PropsWithChildren) {
  const [language, setLanguageState] = useState<Language>(() => readStoredLanguage());
  const setLanguage = (next: Language) => {
    setLanguageState(next);
    persistLanguage(next);
  };
  // index.html declares Chinese. Keep what assistive technology reads in step
  // with the chosen language, on first load and on every switch.
  useEffect(() => {
    applyDocumentLanguage(language);
  }, [language]);
  const value = useMemo(() => ({ language, setLanguage, t: createTranslator(language) }), [language]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageContextValue {
  const value = useContext(LanguageContext);
  if (value) return value;
  return { language: "zh-CN", setLanguage: () => undefined, t: createTranslator("zh-CN") };
}

export function LanguageToggle() {
  const { language, setLanguage, t } = useLanguage();
  return (
    <div className="languageToggle" role="group" aria-label={t("language.label")}>
      <button
        type="button"
        aria-pressed={language === "zh-CN"}
        aria-label={t("language.chineseAria")}
        onClick={() => setLanguage("zh-CN")}
      >
        {t("language.chinese")}
      </button>
      <button
        type="button"
        aria-pressed={language === "en-US"}
        aria-label={t("language.englishAria")}
        onClick={() => setLanguage("en-US")}
      >
        {t("language.english")}
      </button>
    </div>
  );
}
