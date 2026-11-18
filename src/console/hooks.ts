import { useCallback, useEffect, useRef, useState } from "react";
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

export type ConsoleData = {
  me: Me | null;
  projects: Project[] | null;
  usage: Usage | null;
  ledger: LedgerEntry[] | null;
  loadError: string;
  refreshMe: () => Promise<void>;
  refreshProjects: () => Promise<void>;
  /** Balance, usage and ledger after money moved. */
  refreshMoney: () => Promise<void>;
  setProjects: (projects: Project[]) => void;
};

export function useConsoleData({ api, token, fail }: Session): ConsoleData {
  const [me, setMe] = useState<Me | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const guard = useCallback(
    async (work: () => Promise<void>) => {
      try {
        await work();
        if (alive.current) setLoadError("");
      } catch (error) {
        const message = fail(error);
        if (alive.current) setLoadError(message);
      }
    },
    [fail]
  );

  const refreshMe = useCallback(
    () =>
      guard(async () => {
        const next = await api.me(token);
        if (alive.current) setMe(next);
      }),
    [api, token, guard]
  );
  const refreshProjects = useCallback(
    () =>
      guard(async () => {
        const next = await api.listProjects(token);
        if (alive.current) setProjects(next.projects);
      }),
    [api, token, guard]
  );
  const refreshMoney = useCallback(
    () =>
      guard(async () => {
        const [nextMe, nextUsage, nextLedger] = await Promise.all([api.me(token), api.usage(token), api.ledger(token)]);
        if (!alive.current) return;
        setMe(nextMe);
        setUsage(nextUsage);
        setLedger(nextLedger.entries);
      }),
    [api, token, guard]
  );

  useEffect(() => {
    void refreshProjects();
    void refreshMoney();
  }, [refreshProjects, refreshMoney]);

  return { me, projects, usage, ledger, loadError, refreshMe, refreshProjects, refreshMoney, setProjects };
}
