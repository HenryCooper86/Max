import { useCallback, useEffect, useMemo, useState } from "react";
import { LanguageProvider, LanguageToggle } from "../components/LanguageToggle";
import { CONTACT_EMAIL, contactUrl } from "../lib/pricing";
import { PRICING_PATH, REPOSITORY_URL } from "../lib/routes";
import { ApiError, createCloudApi } from "./api";
import { Mascot } from "../components/Mascot";
import { SiteMark, useSiteLogo } from "../components/SiteMark";
import { AuthCard, inviteFromLocation } from "./AuthCard";
import { BalanceCard } from "./BalanceCard";
import { useConsoleData, useSay, type Session } from "./hooks";
import { ProjectsSection } from "./ProjectsSection";
import { readToken, storeToken } from "./session";
import { TopUpDialog } from "./TopUpDialog";
import { ActivitySection, UsageSection } from "./UsageSection";

const DOCS_URL = `${REPOSITORY_URL}#readme`;

function ConsoleFooter() {
  const say = useSay();
  return (
    <footer className="siteFooter cxFooter">
      <p className="siteFooterContact">
        {say("问题、邀请或增加余额：", "Questions, invitations or balance: ")}
        <a href={contactUrl("Max Cloud")}>{CONTACT_EMAIL}</a>
      </p>
    </footer>
  );
}

function ConsoleHeader({ onLogout }: { onLogout?: () => void }) {
  const say = useSay();
  const { logoUrl } = useSiteLogo();
  return (
    <header className="siteHeader">
      <a className="siteBrand" href="/" aria-label={say("Max 首页", "Max home")}>
        <SiteMark logoUrl={logoUrl} />
        <span>Max</span>
      </a>
      <nav className="siteNav" aria-label={say("页面导航", "Page")}>
        <a href={DOCS_URL} rel="noreferrer noopener">
          {say("文档", "Docs")}
        </a>
        <a href={PRICING_PATH}>{say("价格", "Pricing")}</a>
        <a href="/console" aria-current="page">
          {say("控制台", "Console")}
        </a>
      </nav>
      <div className="siteHeaderActions">
        <LanguageToggle />
        {onLogout ? (
          <button type="button" className="siteButton secondary small" onClick={onLogout}>
            {say("退出登录", "Log out")}
          </button>
        ) : null}
      </div>
    </header>
  );
}

function Dashboard({ session }: { session: Session }) {
  const say = useSay();
  const data = useConsoleData(session);
  const [topUp, setTopUp] = useState(false);
  const closeTopUp = useCallback(() => setTopUp(false), []);
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return (
    <div className="cxStack">
      <p className="cxError" aria-live="polite">
        {data.loadError}
      </p>
      <BalanceCard me={data.me} onTopUp={() => setTopUp(true)} />
      <ProjectsSection
        session={session}
        projects={data.projects}
        setProjects={data.setProjects}
        origin={origin}
        onMoney={() => void data.refreshMoney()}
      />
      <UsageSection usage={data.usage} />
      <ActivitySection entries={data.ledger} />
      {data.me ? (
        <p className="cxMuted">{say(`已登录：${data.me.customer.email}`, `Signed in as ${data.me.customer.email}`)}</p>
      ) : null}
      {topUp ? <TopUpDialog session={session} onClose={closeTopUp} onPaid={() => void data.refreshMoney()} /> : null}
    </div>
  );
}

export function NotEnabled() {
  const say = useSay();
  return (
    <section className="cxCard cxAuth" aria-labelledby="cx-off">
      <h1 id="cx-off">{say("这台服务器没有启用 Max Cloud。", "Max Cloud isn't enabled on this server.")}</h1>
      <p className="cxMuted">
        {say(
          "请联系运营这台服务器的人，或使用自己部署的 Max。",
          "Ask whoever runs this server, or self-host Max instead."
        )}
      </p>
    </section>
  );
}

function Console() {
  const say = useSay();
  const api = useMemo(() => createCloudApi(), []);
  const [token, setToken] = useState<string | null>(() => readToken());
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    document.title = say("控制台 · Max Cloud", "Console · Max Cloud");
  }, [say]);

  // Logged out: ask once whether Max Cloud is on at all.
  useEffect(() => {
    if (token) return;
    api.packs(null).catch((error) => {
      if (error instanceof ApiError && error.kind === "unavailable") setUnavailable(true);
    });
  }, [api, token]);

  const signOut = useCallback(() => {
    storeToken(null);
    setToken(null);
  }, []);

  const fail = useCallback(
    (error: unknown): string => {
      if (error instanceof ApiError) {
        if (error.kind === "unauthorized") signOut();
        else if (error.kind === "unavailable") setUnavailable(true);
        return error.message;
      }
      return "Something went wrong. Try again.";
    },
    [signOut]
  );

  const logout = () => {
    const current = token;
    signOut();
    if (current) void api.logout(current).catch(() => undefined);
  };

  const session: Session | null = useMemo(() => (token ? { api, token, fail } : null), [api, token, fail]);

  return (
    <div className="site cxSite">
      <ConsoleHeader onLogout={session ? logout : undefined} />
      <main id="main" className="siteMain cxMain">
        {unavailable ? (
          <NotEnabled />
        ) : session ? (
          <Dashboard session={session} />
        ) : (
          <AuthCard
            api={api}
            invite={inviteFromLocation(window.location.search)}
            onSignedIn={(next) => {
              storeToken(next);
              // The invitation is used up: keep it out of the address bar and history.
              if (window.location.search) window.history.replaceState(null, "", window.location.pathname);
              setToken(next);
            }}
          />
        )}
      </main>
      <ConsoleFooter />
      {/* The site's bird: ready at the door, happy once you are in. */}
      <Mascot
        className="siteBird"
        mood={session ? "happy" : "ready"}
        followCursor
        restOver="a, button, input, select, textarea, label, .cxCard, .cxDialog, .siteHeader"
      />
    </div>
  );
}

export function ConsoleApp() {
  return (
    <LanguageProvider>
      <Console />
    </LanguageProvider>
  );
}
