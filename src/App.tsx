import { MusicPlaybackCard } from "./components/MusicPlaybackCard";
import { ArrowBendUpRight, ChatCircleText, GearSix, Microphone, NavigationArrow, X } from "@phosphor-icons/react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import type { VoiceVisualizer } from "../shared/agent";
import { combineHazardLevels } from "../shared/ride";
import { AssistantProvider } from "./components/AssistantContext";
import { BrandMark, VisorVisual, VoiceStateReadout } from "./components/VisorVisual";
import { LoginGate } from "./components/LoginGate";
import { NavigationPanel } from "./components/NavigationPanel";
import { VoiceTranscript } from "./components/VoiceTranscript";
import { WebSettingsSheet } from "./components/WebSettingsSheet";
import { LanguageProvider, useLanguage } from "./components/LanguageToggle";
import { surfaceAfterAuthentication, type AppSurface } from "./components/admin/admin-model";
import {
  leaveWorkspaceLocation,
  setWorkspaceLocation,
  useWorkspaceLocation
} from "./components/admin/workspace-location";
import { useAmapConsent } from "./hooks/useAmapConsent";
import { useHelmetAgent } from "./hooks/useHelmetAgent";
import { fetchCurrentUser, type AuthUser } from "./lib/auth";
import { applyBrandFavicon, resolveAssistant } from "./lib/assistant";
import { loadStoredSettings, saveStoredAppearance } from "./lib/persistence";
import { Mascot, mascotMoodFor } from "./components/Mascot";
import { resolveVisualizer } from "./lib/visualizer";
import { applyAppearance, resolveAppearance } from "./lib/templates";
import { deviceAssistantCopy, localized } from "./lib/i18n";
import { voiceFaceClassName } from "./lib/voice-shell";

const OperationsWorkspace = lazy(() =>
  import("./components/admin/OperationsWorkspace").then((module) => ({ default: module.OperationsWorkspace }))
);

function AppContent() {
  const { language, t } = useLanguage();
  const agent = useHelmetAgent();
  const { listening, starting, startMic, stopMic } = agent;
  const location = useWorkspaceLocation();
  const lastWorkspaceLocation = useRef({
    workspace: location.workspace,
    section: location.section,
    params: location.params
  });
  const locationQuery = location.params.toString();
  const [surface, setSurface] = useState<AppSurface>(() => location.workspace ?? "voice");
  const [captionsOpen, setCaptionsOpen] = useState(false);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const closeSettings = useCallback(() => setSurface("voice"), []);
  const openSettings = useCallback(() => setSurface("settings"), []);
  const openTesting = useCallback(() => {
    setWorkspaceLocation("overview", {}, false, "testing");
    setSurface("testing");
  }, []);
  const openAdmin = useCallback(() => {
    setWorkspaceLocation("overview", {}, false, "admin");
    setSurface("admin");
  }, []);
  const openStudio = useCallback(() => {
    setWorkspaceLocation("studio", {}, false, "admin");
    setSurface("admin");
  }, []);
  const closeWorkspace = useCallback(() => {
    if (!window.dispatchEvent(new Event("admin:beforeleave", { cancelable: true }))) return false;
    window.dispatchEvent(new Event("admin:didleave"));
    leaveWorkspaceLocation();
    setSurface("voice");
    window.requestAnimationFrame(() => settingsButtonRef.current?.focus());
    return true;
  }, []);

  useEffect(() => {
    if (location.workspace) {
      lastWorkspaceLocation.current = {
        workspace: location.workspace,
        section: location.section,
        params: new URLSearchParams(locationQuery)
      };
      setSurface(location.workspace);
    } else if (surface === "admin" || surface === "testing") {
      if (!window.dispatchEvent(new Event("admin:beforeleave", { cancelable: true }))) {
        const previous = lastWorkspaceLocation.current;
        setWorkspaceLocation(
          previous.section,
          Object.fromEntries(previous.params),
          true,
          previous.workspace ?? undefined
        );
      } else {
        window.dispatchEvent(new Event("admin:didleave"));
        setSurface("voice");
      }
    }
  }, [location.workspace, location.section, locationQuery, surface]);

  // Site-wide access gate: once any account exists on the relay, the voice
  // face stays hidden behind authentication. The relay enforces this too.
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  // One decision shared by the panel's prompt and the settings sheet, keyed by
  // account so a shared browser never reuses another rider's answer.
  const amapConsent = useAmapConsent(authUser?.id ?? null);
  const { setTesterId, selectTranscriptOwner, refreshHealth, disconnect, musicController } = agent;

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
        musicController.clear();
        void refreshHealth();
      });
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [authUser, disconnect, refreshHealth, selectTranscriptOwner, musicController]);

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
    agent.musicController.clear();
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

  // Branding from the relay (/health → assistant). Keyed on the serialised
  // summary so the 5 s health poll does not churn the identity object.
  const assistantKey = JSON.stringify(agent.health?.assistant ?? null);
  const assistant = useMemo(() => resolveAssistant(JSON.parse(assistantKey)), [assistantKey]);
  useEffect(() => {
    document.title = assistant.name;
  }, [assistant.name]);
  useEffect(() => {
    applyBrandFavicon(document, assistant.logoUrl);
  }, [assistant.logoUrl]);
  // Design template: the owner's choice from the relay, the viewer's own
  // choice (remembered on this device) unless the owner pinned it, then the
  // owner's token overrides and brand accent. Applied before paint so a
  // template switch never flashes the previous one.
  const [viewerTemplate, setViewerTemplate] = useState(() => loadStoredSettings().template);
  const appearance = useMemo(
    () =>
      resolveAppearance({
        relayTemplate: assistant.template,
        viewerTemplate,
        templateSwitching: assistant.templateSwitching,
        theme: assistant.theme,
        accentColor: assistant.accentColor
      }),
    [assistant, viewerTemplate]
  );
  useLayoutEffect(() => {
    applyAppearance(appearance);
  }, [appearance]);
  const chooseTemplate = useCallback((id: string) => {
    setViewerTemplate(id);
    saveStoredAppearance({ template: id });
  }, []);
  // Voice display style, with the same precedence and pinning as the template.
  const [viewerVisualizer, setViewerVisualizer] = useState(() => loadStoredSettings().visualizer);
  const visualizer = resolveVisualizer({
    relay: assistant.visualizer,
    viewer: viewerVisualizer,
    templateSwitching: assistant.templateSwitching
  });
  const chooseVisualizer = useCallback((id: VoiceVisualizer) => {
    setViewerVisualizer(id);
    saveStoredAppearance({ visualizer: id });
  }, []);
  const branded = (node: ReactNode) => <AssistantProvider value={assistant}>{node}</AssistantProvider>;

  const fusedHazard = combineHazardLevels(agent.rideContext.hazardLevel, agent.weather?.riskLevel ?? "normal");
  const showRidePanels = agent.navState.phase !== "idle" || agent.musicState.visible || captionsOpen;
  // "Live" is what the wearer experiences as a session: the relay is up AND the
  // microphone is open. Ending hands-free keeps the relay socket warm on
  // purpose (a quick restart, and it closes itself when idle), but to the
  // wearer the session is over — the screen must say so, not "connected".
  const sessionLive = agent.connected && listening;
  const sessionInactive = !listening && !starting;
  const authKnown = agent.health !== null;
  const authEnabled = agent.health?.auth?.enabled ?? false;
  const registrationOpen = agent.health?.auth?.registrationOpen ?? true;

  if (!authChecked || (!authUser && !authKnown && !healthTimedOut)) {
    return <main className="loginShell" aria-busy="true" />;
  }

  if (!authUser) {
    return branded(
      <LoginGate
        authEnabled={authKnown ? authEnabled : true}
        registrationOpen={registrationOpen}
        onSignedIn={handleSignedIn}
      />
    );
  }

  if (surface === "admin" || surface === "testing") {
    return branded(
      <Suspense
        fallback={
          <main className="adminWorkspace workspaceBoot" aria-busy="true">
            <div className="workspaceBootStatus" role="status">
              <span className="workspaceSpinner" aria-hidden="true" />
              {localized(language, "正在加载工作区…", "Loading workspace…")}
            </div>
          </main>
        }
      >
        <OperationsWorkspace
          agent={agent}
          user={authUser}
          onAuthenticationExpired={handleSignedOut}
          onClose={closeWorkspace}
        />
      </Suspense>
    );
  }

  const sessionPhase = starting ? "starting" : sessionInactive ? "inactive" : undefined;
  const micLive = listening || starting;

  return branded(
    <main className="voiceShell">
      <section
        className={`${voiceFaceClassName({ captionsOpen, navigationVisible: agent.navState.phase !== "idle" })}${showRidePanels ? " voiceWithPanels" : ""}`}
        aria-label={deviceAssistantCopy(t, language, "voice.assistantLabel", assistant, { name: assistant.name })}
      >
        <header
          className={`voiceTopbar ${sessionLive ? "online" : starting ? "starting" : sessionInactive ? "inactive" : "offline"}`}
        >
          <div className="voiceBrand">
            <BrandMark />
            <span className="voiceWordmark">{assistant.name}</span>
          </div>
          <div className="voiceRelay" role="status">
            <span className="voiceRelayDot" aria-hidden="true" />
            {sessionLive
              ? t("voice.sessionConnected")
              : starting
                ? t("voice.connectingShort")
                : sessionInactive
                  ? t("voice.sessionInactive")
                  : t("voice.offline")}
          </div>
        </header>

        {agent.hazardAlert ? (
          <div className={`hazardBanner voiceHazard ${agent.hazardAlert.severity}`} role="alert" aria-live="assertive">
            <span className="hazardDir">{t(`hazard.direction.${agent.hazardAlert.direction}`)}</span>
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
          <VisorVisual
            connected={sessionLive}
            listening={agent.listening}
            voiceLevel={agent.voiceLevel}
            turnState={agent.turnState}
            hazardLevel={fusedHazard}
            sessionState={sessionPhase}
            visualizer={visualizer}
            getAnalyser={agent.getVoiceAnalyser}
          />
          <Mascot
            className="voiceBird"
            mood={mascotMoodFor({
              connected: sessionLive,
              turnState: agent.turnState,
              hazardLevel: fusedHazard,
              sessionState: sessionPhase
            })}
            followCursor
            restOver=".voiceUtilities, .voicePrimaryControls, .voiceRidePanels, .voiceTopbar"
          />
        </div>

        <VoiceStateReadout
          connected={sessionLive}
          turnState={agent.turnState}
          hazardLevel={fusedHazard}
          sessionState={sessionPhase}
        />

        {showRidePanels ? (
          <div className="voiceRidePanels">
            {agent.navState.phase !== "idle" ? (
              <NavigationPanel
                state={agent.navState}
                mapConsent={amapConsent.decision}
                onEnableMap={amapConsent.accept}
              />
            ) : null}

            {agent.musicState.visible ? <MusicPlaybackCard agent={agent} /> : null}
            {captionsOpen ? <VoiceTranscript agent={agent} /> : null}
          </div>
        ) : null}

        <nav className="voiceUtilities" aria-label={t("voice.viewLabel")}>
          <button
            type="button"
            className={captionsOpen ? "active" : ""}
            aria-pressed={captionsOpen}
            onClick={() => setCaptionsOpen((open) => !open)}
          >
            <ChatCircleText size={18} weight="regular" aria-hidden="true" />
            {t("voice.captions")}
          </button>
          {agent.provider === "mock" ? (
            <button type="button" onClick={() => agent.startNavDemo(false)}>
              <NavigationArrow size={18} weight="regular" aria-hidden="true" />
              {localized(language, "演示导航", "Demo navigate")}
            </button>
          ) : null}
          {agent.provider === "mock" ? (
            <button type="button" onClick={() => agent.startNavDemo(true)}>
              <ArrowBendUpRight size={18} weight="regular" aria-hidden="true" />
              {localized(language, "演示偏航", "Demo detour")}
            </button>
          ) : null}
          <button ref={settingsButtonRef} type="button" onClick={openSettings} aria-haspopup="dialog">
            <GearSix size={18} weight="regular" aria-hidden="true" />
            {t("voice.settings")}
          </button>
        </nav>

        <div className="voicePrimaryControls">
          <button
            type="button"
            className={`voiceMicButton${micLive ? " active" : ""}${starting ? " starting" : ""}`}
            aria-pressed={micLive}
            aria-label={
              starting ? t("voice.connecting") : listening ? t("voice.stopHandsFree") : t("voice.startHandsFree")
            }
            onClick={toggleHandsFreeSession}
          >
            <span className="voiceMicKey" aria-hidden="true">
              {micLive ? <X size={22} weight="bold" /> : <Microphone size={24} weight="fill" />}
            </span>
            <span className="voiceMicText">
              <span className="voiceMicLabel">
                {starting
                  ? t("voice.connectingShort")
                  : listening
                    ? t("voice.stopHandsFree")
                    : t("voice.startHandsFree")}
              </span>
              <span className="voiceMicState">
                {starting ? t("voice.setupShort") : listening ? t("voice.micLive") : t("voice.micOff")}
              </span>
            </span>
            <kbd aria-hidden="true">{t("voice.spaceKey")}</kbd>
          </button>
        </div>
      </section>

      {surface === "settings" ? (
        <WebSettingsSheet
          agent={agent}
          amapConsent={amapConsent}
          onOpenTesting={openTesting}
          onOpenAdmin={authUser.role === "admin" ? openAdmin : undefined}
          onOpenStudio={authUser.role === "admin" ? openStudio : undefined}
          appearance={{
            templateId: appearance.template.id,
            pinned: assistant.templateSwitching === false,
            onSelect: chooseTemplate,
            visualizer,
            onSelectVisualizer: chooseVisualizer
          }}
          onClose={closeSettings}
        />
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
