import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LanguageProvider, LanguageToggle } from "../components/LanguageToggle";
import { CONTACT_EMAIL, contactUrl } from "../lib/pricing";
import { CONSOLE_PATH, PRICING_PATH, REPOSITORY_URL } from "../lib/routes";
import { ApiError, createCloudApi } from "./api";
import { Mascot } from "../components/Mascot";
import { SiteMark, useSiteLogo } from "../components/SiteMark";
import { AccountCard } from "./AccountCard";
import { AuthCard, inviteFromLocation, type Notice } from "./AuthCard";
import { BalanceCard } from "./BalanceCard";
import { useConsoleData, useSay, type Session } from "./hooks";
import { ProjectsSection } from "./ProjectsSection";
import { readToken, storeToken } from "./session";
import { TopUpDialog } from "./TopUpDialog";
import { ActivitySection, UsageSection } from "./UsageSection";
import { isResetPath, ResetPasswordCard, resetTokenFromLocation } from "./ResetPasswordCard";

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

function Dashboard({ session, onSignedOut }: { session: Session; onSignedOut: () => void }) {
  const say = useSay();
  const data = useConsoleData(session);
  // The button that opened the top-up dialog, so that it can return the focus there.
  const [topUpOpener, setTopUpOpener] = useState<HTMLButtonElement | null>(null);
  const closeTopUp = useCallback(() => setTopUpOpener(null), []);
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return (
    <div className="cxStack">
      <p className="cxError" aria-live="polite">
        {data.moneyError}
      </p>
      {data.moneyError && (
        <button type="button" className="siteButton secondary small" onClick={data.refreshMoney}>
          {say("重试", "Retry")}
        </button>
      )}
      <BalanceCard me={data.me} onTopUp={setTopUpOpener} />
      <ProjectsSection
        session={session}
        projects={data.projects}
        error={data.projectsError}
        onRetry={data.refreshProjects}
        setProjects={data.setProjects}
        origin={origin}
        onMoney={data.refreshMoney}
      />
      <UsageSection usage={data.usage} />
      <ActivitySection entries={data.ledger} />
      <AccountCard session={session} email={data.me?.customer.email ?? null} onSignedOut={onSignedOut} />
      {topUpOpener ? (
        <TopUpDialog session={session} opener={topUpOpener} onClose={closeTopUp} onPaid={data.refreshMoney} />
      ) : null}
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
  // What the log-in card says at its top: a password was set, or every device was signed out.
  const [notice, setNotice] = useState<Notice | null>(null);
  const activeToken = useRef(token);
  const changeToken = useCallback((next: string | null) => {
    activeToken.current = next;
    storeToken(next);
    setToken(next);
    setUnavailable(false);
  }, []);

  // `/console/reset`, the page a password-reset link opens, whoever is signed in on this browser.
  const resetting = isResetPath(window.location.pathname);
  const resetToken = resetting ? resetTokenFromLocation(window.location.search) : null;
  useEffect(() => {
    document.title = resetting
      ? say("重置密码 · Max Cloud", "Reset password · Max Cloud")
      : say("控制台 · Max Cloud", "Console · Max Cloud");
  }, [say, resetting]);

  // Logged out: ask once whether Max Cloud is on at all.
  useEffect(() => {
    if (token) return;
    let active = true;
    api.packs(null).catch((error) => {
      if (active && !activeToken.current && error instanceof ApiError && error.kind === "unavailable")
        setUnavailable(true);
    });
    return () => {
      active = false;
    };
  }, [api, token]);

  const fail = useCallback(
    (error: unknown): string => {
      if (error instanceof ApiError) {
        if (token !== activeToken.current) return error.message;
        if (error.kind === "unauthorized") changeToken(null);
        else if (error.kind === "unavailable") setUnavailable(true);
        return error.message;
      }
      return "Something went wrong. Try again.";
    },
    [token, changeToken]
  );

  const logout = () => {
    const current = token;
    setNotice(null);
    changeToken(null);
    if (current) void api.logout(current).catch(() => undefined);
  };

  // Every session ended on the relay: forget this browser's, and say so on the log-in card.
  const signedOutEverywhere = () => {
    setNotice({ zh: "已在所有设备上退出登录。", en: "You are signed out on every device." });
    changeToken(null);
  };

  // The link is used up, and every session ended with it: keep the token out of the address bar and history.
  const passwordReset = (email: string) => {
    setNotice({
      zh: `密码已修改。请用新密码登录 ${email}。`,
      en: `Your password is changed. Log in to ${email} with the new one.`,
      email
    });
    window.history.replaceState(null, "", CONSOLE_PATH);
    changeToken(null);
  };

  const session: Session | null = useMemo(() => (token ? { api, token, fail } : null), [api, token, fail]);

  return (
    <div className="site cxSite">
      <ConsoleHeader onLogout={session ? logout : undefined} />
      <main id="main" className="siteMain cxMain">
        {unavailable ? (
          <NotEnabled />
        ) : resetToken !== null ? (
          <ResetPasswordCard api={api} token={resetToken} onError={fail} onDone={passwordReset} />
        ) : session ? (
          <Dashboard session={session} onSignedOut={signedOutEverywhere} />
        ) : (
          <AuthCard
            api={api}
            notice={notice}
            invite={inviteFromLocation(window.location.search)}
            onSignedIn={(next) => {
              setNotice(null);
              changeToken(next);
              // The invitation is used up: keep it out of the address bar and history.
              if (window.location.search) window.history.replaceState(null, "", window.location.pathname);
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
