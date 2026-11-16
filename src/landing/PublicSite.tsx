import { useEffect, useLayoutEffect, useState } from "react";
import { LanguageProvider, LanguageToggle, useLanguage } from "../components/LanguageToggle";
import { fetchCurrentUser } from "../lib/auth";
import { localized } from "../lib/i18n";
import { loadStoredSettings } from "../lib/persistence";
import { APP_PATH, BUILD_PATH, REPOSITORY_URL } from "../lib/routes";
import { applyAppearance, resolveAppearance } from "../lib/templates";
import { applyBrandFavicon, resolveAssistant } from "../lib/assistant";
import { fetchAgentHealth } from "../lib/utils";
import { BuildPage } from "./BuildPage";
import { LandingPage } from "./LandingPage";

/** The mark beside the name: the owner's logo from the relay when there is
 *  one, otherwise (or if it fails to load) the built-in lens. */
function SiteMark({ logoUrl }: { logoUrl?: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (logoUrl && failedUrl !== logoUrl) {
    return (
      <img
        className="brandLogo siteLogo"
        src={logoUrl}
        alt=""
        decoding="async"
        draggable={false}
        onError={() => setFailedUrl(logoUrl)}
      />
    );
  }
  return (
    <svg className="siteMark" viewBox="0 0 48 20" aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="46" height="18" rx="9" />
      <path d="M9 10h6l3-5 4 10 4-8 3 3h10" />
    </svg>
  );
}

function SiteHeader({ signedIn, view, logoUrl }: { signedIn: boolean; view: "landing" | "build"; logoUrl?: string }) {
  const { language } = useLanguage();
  const say = (zh: string, en: string) => localized(language, zh, en);
  const home = view === "landing" ? "" : "/";
  return (
    <header className="siteHeader">
      <a className="siteBrand" href="/" aria-label={say("Max 首页", "Max home")}>
        <SiteMark logoUrl={logoUrl} />
        <span>Max</span>
      </a>
      <nav className="siteNav" aria-label={say("页面导航", "Page")}>
        <a href={`${home}#demo`}>{say("演示", "Demo")}</a>
        <a href={`${home}#devices`}>{say("设备", "Devices")}</a>
        <a href={`${home}#backends`}>{say("语音后端", "Backends")}</a>
        <a href={BUILD_PATH} aria-current={view === "build" ? "page" : undefined}>
          {say("配置器", "Build yours")}
        </a>
      </nav>
      <div className="siteHeaderActions">
        <LanguageToggle />
        <a className="siteButton small" href={APP_PATH}>
          {signedIn ? say("打开应用", "Open the app") : say("登录", "Sign in")}
        </a>
      </div>
    </header>
  );
}

function SiteFooter({ developer }: { developer?: string }) {
  const { language } = useLanguage();
  const say = (zh: string, en: string) => localized(language, zh, en);
  return (
    <footer className="siteFooter">
      <div>
        <strong>Max</strong>
        <p>
          {say(
            "为可穿戴设备打造语音助手的开放框架，自行部署。",
            "An open, self-hosted framework for voice assistants on things people wear."
          )}
        </p>
        {developer ? <p className="siteFooterMaker">{developer}</p> : null}
      </div>
      <nav aria-label={say("页脚链接", "Footer")}>
        <a href={APP_PATH}>{say("打开应用", "Open the app")}</a>
        <a href={BUILD_PATH}>{say("配置器", "Build yours")}</a>
        {REPOSITORY_URL ? (
          <a href={REPOSITORY_URL} rel="noreferrer noopener">
            GitHub
          </a>
        ) : null}
      </nav>
    </footer>
  );
}

function Site({ view }: { view: "landing" | "build" }) {
  const { language } = useLanguage();
  const [signedIn, setSignedIn] = useState(false);
  const [developer, setDeveloper] = useState<string | undefined>();
  const [logoUrl, setLogoUrl] = useState<string | undefined>();

  // The visitor's own template from the app's Settings, else the default.
  useLayoutEffect(() => {
    applyAppearance(resolveAppearance({ viewerTemplate: loadStoredSettings().template }));
  }, []);

  useEffect(() => {
    document.title =
      view === "build"
        ? localized(language, "配置你的助手 · Max", "Build your assistant · Max")
        : localized(language, "Max：为可穿戴设备打造语音助手", "Max: voice assistants for things people wear");
  }, [language, view]);

  useEffect(() => {
    let active = true;
    void fetchCurrentUser().then((result) => {
      if (active) setSignedIn(result.status === "authenticated");
    });
    void fetchAgentHealth().then((health) => {
      if (!active) return;
      setDeveloper(health?.assistant?.developer);
      // The owner's logo is the header mark and the favicon here too, as it
      // is in the app.
      const logo = resolveAssistant(health?.assistant ?? null).logoUrl;
      setLogoUrl(logo);
      applyBrandFavicon(document, logo);
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="site">
      <a className="skipLink" href="#main">
        {localized(language, "跳到正文", "Skip to content")}
      </a>
      <SiteHeader signedIn={signedIn} view={view} logoUrl={logoUrl} />
      <main id="main" className="siteMain">
        {view === "build" ? <BuildPage /> : <LandingPage signedIn={signedIn} />}
      </main>
      <SiteFooter developer={developer} />
    </div>
  );
}

/** The public surfaces: the landing page at / and the configurator at /build. */
export function PublicSite({ view }: { view: "landing" | "build" }) {
  return (
    <LanguageProvider>
      <Site view={view} />
    </LanguageProvider>
  );
}
