import { useEffect, useLayoutEffect, useState } from "react";
import { LanguageProvider, LanguageToggle, useLanguage } from "../components/LanguageToggle";
import { fetchCurrentUser } from "../lib/auth";
import { localized } from "../lib/i18n";
import { loadStoredSettings } from "../lib/persistence";
import { APP_PATH, BUILD_PATH, CONSOLE_PATH, PRICING_PATH, REPOSITORY_URL } from "../lib/routes";
import { applyAppearance, resolveAppearance } from "../lib/templates";
import { applyBrandFavicon, resolveAssistant } from "../lib/assistant";
import { fetchAgentHealth } from "../lib/utils";
import { SiteMark } from "../components/SiteMark";
import { CONTACT_EMAIL, contactUrl } from "../lib/pricing";
import { BuildPage } from "./BuildPage";
import { LandingPage } from "./LandingPage";
import { PricingPage } from "./PricingPage";

function SiteHeader({
  signedIn,
  view,
  logoUrl
}: {
  signedIn: boolean;
  view: "landing" | "build" | "pricing";
  logoUrl?: string;
}) {
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
        <a href={`${home}#characters`}>{say("角色", "Characters")}</a>
        <a href={BUILD_PATH} aria-current={view === "build" ? "page" : undefined}>
          {say("配置器", "Build yours")}
        </a>
        <a href={PRICING_PATH} aria-current={view === "pricing" ? "page" : undefined}>
          {say("价格", "Pricing")}
        </a>
        <a href={CONSOLE_PATH}>{say("控制台", "Console")}</a>
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
            "开源的实时语音智能体工具包：放进网站、应用或可穿戴设备，自己部署或交给 Max Cloud。",
            "Open-source realtime voice agents for websites, apps and wearables. Host it yourself, or let Max Cloud run it."
          )}
        </p>
        {developer ? <p className="siteFooterMaker">{developer}</p> : null}
        <p className="siteFooterContact">
          {say("联系：", "Contact: ")}
          <a href={contactUrl("Max")}>{CONTACT_EMAIL}</a>
        </p>
      </div>
      <nav aria-label={say("页脚链接", "Footer")}>
        <a href={APP_PATH}>{say("打开应用", "Open the app")}</a>
        <a href={BUILD_PATH}>{say("配置器", "Build yours")}</a>
        <a href={PRICING_PATH}>{say("价格", "Pricing")}</a>
        <a href={CONSOLE_PATH}>{say("控制台", "Console")}</a>
        {REPOSITORY_URL ? (
          <a href={REPOSITORY_URL} rel="noreferrer noopener">
            GitHub
          </a>
        ) : null}
      </nav>
    </footer>
  );
}

function Site({ view }: { view: "landing" | "build" | "pricing" }) {
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
        : view === "pricing"
          ? localized(language, "价格 · Max", "Pricing · Max")
          : localized(language, "Max：给你的产品加上语音智能体", "Max: voice agents for your product");
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
        {view === "build" ? <BuildPage /> : view === "pricing" ? <PricingPage /> : <LandingPage signedIn={signedIn} />}
      </main>
      <SiteFooter developer={developer} />
    </div>
  );
}

/** The public surfaces: the landing page at /, the configurator at /build and pricing at /pricing. */
export function PublicSite({ view }: { view: "landing" | "build" | "pricing" }) {
  return (
    <LanguageProvider>
      <Site view={view} />
    </LanguageProvider>
  );
}
