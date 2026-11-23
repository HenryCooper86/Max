import { useCallback, useEffect, useState } from "react";
import { useLanguage } from "../components/LanguageToggle";
import { localized } from "../lib/i18n";
import { type CloudApi, type LedgerEntry, type Me, type Project, type Usage } from "./api";

/** `say("中文", "English")` in the visitor's language. */
export function useSay() {
  const { language } = useLanguage();
  return useCallback((zh: string, en: string) => localized(language, zh, en), [language]);
}

/** What every section needs: the client, the token, and one place to report a
 *  failed call. `fail` signs the visitor out on 401, shows the "not enabled"
 *  page on 503, and returns a message to show inline otherwise. */
export type Session = { api: CloudApi; token: string; fail: (error: unknown) => string };

export function useConsoleData({ api, token, fail }: Session) {
  const [me, setMe] = useState<Me | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[] | null>(null);
  const [projectsError, setProjectsError] = useState("");
  const [moneyError, setMoneyError] = useState("");
  const [projectsVersion, setProjectsVersion] = useState(0);
  const [moneyVersion, setMoneyVersion] = useState(0);

  useEffect(() => {
    let active = true;
    api.listProjects(token).then(
      (result) => {
        if (!active) return;
        setProjects(result.projects);
        setProjectsError("");
      },
      (error) => {
        if (active) setProjectsError(fail(error));
      }
    );
    return () => {
      active = false;
    };
  }, [api, token, fail, projectsVersion]);

  useEffect(() => {
    let active = true;
    Promise.all([api.me(token), api.usage(token), api.ledger(token)]).then(
      ([nextMe, nextUsage, nextLedger]) => {
        if (!active) return;
        setMe(nextMe);
        setUsage(nextUsage);
        setLedger(nextLedger.entries);
        setMoneyError("");
      },
      (error) => {
        if (active) setMoneyError(fail(error));
      }
    );
    return () => {
      active = false;
    };
  }, [api, token, fail, moneyVersion]);

  return {
    me,
    projects,
    usage,
    ledger,
    setProjects,
    projectsError,
    moneyError,
    refreshProjects: () => setProjectsVersion((version) => version + 1),
    refreshMoney: () => setMoneyVersion((version) => version + 1)
  };
}
