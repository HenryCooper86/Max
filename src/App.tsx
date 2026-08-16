import { ArrowBendUpRight, ChatCircleText, GearSix, Microphone, NavigationArrow, X } from "@phosphor-icons/react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { adasDirectionLabel } from "../shared/adas";
import { combineHazardLevels } from "../shared/ride";
import { HelmetVisual, VoiceStateReadout } from "./components/HelmetVisual";
import { LoginGate } from "./components/LoginGate";
import { NavigationPanel } from "./components/NavigationPanel";
import { VoiceTranscript } from "./components/VoiceTranscript";
import { WebSettingsSheet } from "./components/WebSettingsSheet";
import { LanguageProvider, useLanguage } from "./components/LanguageToggle";
import { surfaceAfterAuthentication, type AppSurface } from "./components/admin/admin-model";
import { useAmapConsent } from "./hooks/useAmapConsent";
import { useHelmetAgent } from "./hooks/useHelmetAgent";
import { fetchCurrentUser, type AuthUser } from "./lib/auth";
import { localized } from "./lib/i18n";

const AdminWorkspace = lazy(() =>
  import("./components/admin/AdminWorkspace").then((module) => ({ default: module.AdminWorkspace }))
);

function AppContent() {
  const { language, t } = useLanguage();
  const agent = useHelmetAgent();
  const { listening, starting, startMic, stopMic } = agent;
  const [surface, setSurface] = useState<AppSurface>("voice");
  const [captionsOpen, setCaptionsOpen] = useState(false);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const closeSettings = useCallback(() => setSurface("voice"), []);
  const openSettings = useCallback(() => setSurface("settings"), []);
  const openAdmin = useCallback(() => setSurface("admin"), []);
  const closeAdmin = useCallback(() => {
    setSurface("voice");
    window.requestAnimationFrame(() => settingsButtonRef.current?.focus());
  }, []);

  // Site-wide access gate: once any account exists on the relay, the voice
  // face stays hidden behind authentication. The relay enforces this too.
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  // One decision shared by the panel's prompt and the settings sheet, keyed by
  // account so a shared browser never reuses another rider's answer.
  const amapConsent = useAmapConsent(authUser?.id ?? null);
  const { setTesterId, selectTranscriptOwner, refreshHealth, disconnect } = agent;

  useEffect(() => {
    let active = true;
    let retryTimer: number | undefined;
    let attempts = 0;
    const resolveAuth = () => {
      void fetchCurrentUser().then((result) => {
        if (!active) return;
        // A transient relay hiccup ("unavailable") is not a logout — the stored
        // token is still valid, and fetchCurrentUser deliberately keeps it. Retry
        // a few times before falling back to the login gate (matching the
        // periodic re-lock effect below), so a live session isn't dropped and the
        // rider forced to sign in again on a momentary blip at page load.
        if (result.status === "unavailable" && attempts < 3) {
          attempts += 1;
          retryTimer = window.setTimeout(resolveAuth, 1500);
          return;
        }
        const user = result.status === "authenticated" ? result.user : null;
        setAuthUser(user);
        selectTranscriptOwner(user?.id ?? null);
        if (user) setTesterId(user.username);
        setAuthChecked(true);
      });
    };
    resolveAuth();
    return () => {
      active = false;
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [selectTranscriptOwner, setTesterId]);

  // Re-lock the app if a server-side session expires or is revoked. Temporary
  // relay failures leave the current screen intact and are retried next poll.
  useEffect(() => {
    if (!authUser) return;
    const timer = window.setInterval(() => {
      void fetchCurrentUser().then((result) => {
        if (result.status === "authenticated") {
          setAuthUser(result.user);
          selectTranscriptOwner(result.user.id);
          return;
        }
        if (result.status === "unavailable") return;
        setSurface((current) => surfaceAfterAuthentication(current, false));
        setAuthUser(null);
        selectTranscriptOwner(null);
        disconnect();
        void refreshHealth();
      });
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [authUser, disconnect, refreshHealth, selectTranscriptOwner]);

  const [healthTimedOut, setHealthTimedOut] = useState(false);
  useEffect(() => {
    if (agent.health) return;
    const timer = window.setTimeout(() => setHealthTimedOut(true), 4000);
    return () => window.clearTimeout(timer);
  }, [agent.health]);

  const handleSignedIn = useCallback(
    (user: AuthUser) => {
      setAuthUser(user);
      agent.selectTranscriptOwner(user.id);
      if (agent.testerId !== user.username) agent.setTesterId(user.username);
      void agent.refreshHealth();
    },
    [agent]
  );

  const handleSignedOut = useCallback(() => {
    setSurface((current) => surfaceAfterAuthentication(current, false));
    setAuthUser(null);
    agent.selectTranscriptOwner(null);
    agent.disconnect();
    void agent.refreshHealth();
  }, [agent]);

  // A second press while permission or connection setup is in flight means
  // stop, matching the one-control interaction in the iOS app.
  const toggleHandsFreeSession = useCallback(() => {
    if (listening || starting) {
      stopMic();
    } else {
      void startMic();
    }
  }, [listening, starting, startMic, stopMic]);

  useEffect(() => {
    if (!authUser || surface !== "voice") return;
    const toggleHandsFree = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName))
      ) {
        return;
      }
      event.preventDefault();
      toggleHandsFreeSession();
    };

    window.addEventListener("keydown", toggleHandsFree);
    return () => window.removeEventListener("keydown", toggleHandsFree);
  }, [authUser, surface, toggleHandsFreeSession]);

  const fusedHazard = combineHazardLevels(agent.rideContext.hazardLevel, agent.weather?.riskLevel ?? "normal");
  const authKnown = agent.health !== null;
  const authEnabled = agent.health?.auth?.enabled ?? false;
  const registrationOpen = agent.health?.auth?.registrationOpen ?? true;

  if (!authChecked || (!authUser && !authKnown && !healthTimedOut)) {
    return <main className="shell loginShell" aria-busy="true" />;
  }

  if (!authUser) {
    return (
      <LoginGate
        authEnabled={authKnown ? authEnabled : true}
        registrationOpen={registrationOpen}
        onSignedIn={handleSignedIn}
      />
    );
  }

  if (surface === "admin") {
    return (
      <Suspense fallback={<main className="adminWorkspace adminWorkspaceLoading">{t("app.loadingAdmin")}</main>}>
        <AdminWorkspace agent={agent} user={authUser} onAuthenticationExpired={handleSignedOut} onClose={closeAdmin} />
      </Suspense>
    );
  }

  return (
    <main className="voiceShell">
      <section className={`voiceFace ${captionsOpen ? "captionsVisible" : ""}`} aria-label="Max 头盔语音助手">
        <header className={`voiceTopbar ${agent.connected ? "online" : "offline"}`}>
          <div className="voiceBrand">
            <span className="voiceBrandDot" aria-hidden="true" />
            <span className="voiceWordmark">MAX</span>
          </div>
          <div className="voiceRelay">
            <span className="voiceRelayDot" aria-hidden="true" />
            {agent.connected ? "RELAY ONLINE" : "RELAY OFFLINE"}
          </div>
        </header>

        {agent.hazardAlert ? (
          <div className={`hazardBanner voiceHazard ${agent.hazardAlert.severity}`} role="alert" aria-live="assertive">
            <span className="hazardDir">{adasDirectionLabel(agent.hazardAlert.direction)}</span>
            <div className="hazardBody">
              <strong>{agent.hazardAlert.label}</strong>
              <p>
                {agent.hazardAlert.message} {agent.hazardAlert.advice}
              </p>
            </div>
            <span className="hazardTtc">{agent.hazardAlert.ttcSeconds}s</span>
          </div>
        ) : null}

        <div className="voiceHero">
          <HelmetVisual
            connected={agent.connected}
            listening={agent.listening}
            voiceLevel={agent.voiceLevel}
            turnState={agent.turnState}
            hazardLevel={fusedHazard}
          />
        </div>

        <VoiceStateReadout connected={agent.connected} turnState={agent.turnState} hazardLevel={fusedHazard} />

        {agent.navState.phase !== "idle" ? (
          <NavigationPanel state={agent.navState} mapConsent={amapConsent.decision} onEnableMap={amapConsent.accept} />
        ) : null}

        {captionsOpen ? <VoiceTranscript agent={agent} /> : null}

        <nav className="voiceUtilities" aria-label={t("voice.viewLabel")}>
          <button
            type="button"
            className={captionsOpen ? "active" : ""}
            aria-pressed={captionsOpen}
            onClick={() => setCaptionsOpen((open) => !open)}
          >
            <ChatCircleText size={20} weight="regular" aria-hidden="true" />
            {t("voice.captions")}
          </button>
          {agent.provider === "mock" ? (
            <button type="button" onClick={() => agent.startNavDemo(false)}>
              <NavigationArrow size={20} weight="regular" aria-hidden="true" />
              {localized(language, "演示导航", "Demo navigate")}
            </button>
          ) : null}
          {agent.provider === "mock" ? (
            <button type="button" onClick={() => agent.startNavDemo(true)}>
              <ArrowBendUpRight size={20} weight="regular" aria-hidden="true" />
              {localized(language, "演示偏航", "Demo detour")}
            </button>
          ) : null}
          <button ref={settingsButtonRef} type="button" onClick={openSettings} aria-haspopup="dialog">
            <GearSix size={20} weight="regular" aria-hidden="true" />
            {t("voice.settings")}
          </button>
        </nav>

        <div className="voicePrimaryControls">
          <button
            type="button"
            className={`voiceMicButton ${listening || starting ? "active" : ""}`}
            aria-pressed={listening || starting}
            aria-label={
              starting ? t("voice.connecting") : listening ? t("voice.stopHandsFree") : t("voice.startHandsFree")
            }
            onClick={toggleHandsFreeSession}
          >
            <span className="voiceMicKey" aria-hidden="true">
              {listening || starting ? <X size={24} weight="bold" /> : <Microphone size={25} weight="regular" />}
            </span>
            <span className="voiceMicLabel">
              {starting ? t("voice.connectingShort") : listening ? t("voice.stopHandsFree") : t("voice.startHandsFree")}
            </span>
            <kbd aria-hidden="true">{t("voice.spaceKey")}</kbd>
          </button>
        </div>
      </section>

      {surface === "settings" ? (
        <WebSettingsSheet agent={agent} amapConsent={amapConsent} onOpenAdmin={openAdmin} onClose={closeSettings} />
      ) : null}
    </main>
  );
}

export function App() {
  return (
    <LanguageProvider>
      <AppContent />
    </LanguageProvider>
  );
}
