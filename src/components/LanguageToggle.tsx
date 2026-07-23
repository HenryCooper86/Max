import { createContext, useContext, useMemo, useState, type PropsWithChildren } from "react";
import { createTranslator, persistLanguage, readStoredLanguage, type Language, type Translator } from "../lib/i18n";

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
  const value = useMemo(() => ({ language, setLanguage, t: createTranslator(language) }), [language]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageContextValue {
  const value = useContext(LanguageContext);
  if (!value) throw new Error("useLanguage must be used inside LanguageProvider");
  return value;
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
