// Full-screen access gate: the login page always comes first, like a normal
// authenticated web app. On a fresh relay it offers first-run (admin)
// registration; an ?invite=… link unlocks registration for a new tester even
// while self-registration is closed. The relay refuses anonymous /agent
// connections once accounts exist, so this is enforcement, not decoration.
//
// The page is also the first thing anyone sees of the assistant, so it shows
// the product rather than describing it: the character plays a short exchange
// on a loop, then hands over to the visitor — it listens while they type,
// thinks while the relay checks the password and starts when it is refused.

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import type { AuthUser } from "../lib/auth";
import { deviceAssistantCopy, localized } from "../lib/i18n";
import { CONTACT_EMAIL, contactUrl } from "../lib/pricing";
import { AccountForm, type AccountFormActivity } from "./AccountBar";
import { useAssistant } from "./AssistantContext";
import { LanguageToggle, useLanguage } from "./LanguageToggle";
import { Mascot, type MascotMood } from "./Mascot";
import { BrandMark } from "./VisorVisual";

type Props = {
  /** False until the first account exists — the gate then offers first-run
   *  (admin) registration instead of plain login. */
  authEnabled: boolean;
  registrationOpen: boolean;
  onSignedIn: (user: AuthUser) => void;
};

function readInviteCode(): string {
  try {
    return new URLSearchParams(window.location.search).get("invite")?.trim() ?? "";
  } catch {
    return "";
  }
}

function clearInviteFromUrl() {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("invite");
    window.history.replaceState(window.history.state, document.title, `${url.pathname}${url.search}${url.hash}`);
  } catch {
    /* cosmetic only */
  }
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

/** One beat of the exchange the lens plays while nobody is typing. */
type DemoStage = "hearing" | "thinking" | "speaking" | "rest";
type Demo = { phrase: number; shown: number; stage: DemoStage };

const TYPE_MS = 55;
const STAGE_MS: Record<Exclude<DemoStage, "hearing">, number> = { thinking: 900, speaking: 2200, rest: 1400 };

/** Plays the phrases one after another: each is "spoken" a character at a
 *  time, thought about, answered, and then the lens rests. With reduced
 *  motion it holds the first phrase and a calm lens. */
function useLoginDemo(phrases: readonly string[], paused: boolean): Demo {
  const [reduced] = useState(prefersReducedMotion);
  const [demo, setDemo] = useState<Demo>({ phrase: 0, shown: 0, stage: "hearing" });
  const lengths = phrases.map((phrase) => phrase.length).join(",");

  useEffect(() => {
    if (reduced || paused || typeof window === "undefined") return;
    const length = phrases[demo.phrase % phrases.length]?.length ?? 0;
    const wait = demo.stage === "hearing" ? (demo.shown === 0 ? 500 : TYPE_MS) : STAGE_MS[demo.stage];
    const timer = setTimeout(() => {
      setDemo((current) => {
        if (current.stage === "hearing") {
          return current.shown < length ? { ...current, shown: current.shown + 1 } : { ...current, stage: "thinking" };
        }
        if (current.stage === "thinking") return { ...current, stage: "speaking" };
        if (current.stage === "speaking") return { ...current, stage: "rest" };
        return { phrase: (current.phrase + 1) % phrases.length, shown: 0, stage: "hearing" };
      });
    }, wait);
    return () => clearTimeout(timer);
    // `lengths` stands in for the phrases: they change only with the language.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, reduced, paused, lengths]);

  if (reduced) return { phrase: 0, shown: phrases[0]?.length ?? 0, stage: "rest" };
  return demo;
}

/** How long the lens stays with the visitor after their last keystroke. */
const TYPING_HOLD_MS = 900;
const ERROR_HOLD_MS = 1800;

export function LoginGate({ authEnabled, registrationOpen, onSignedIn }: Props) {
  const { language, t } = useLanguage();
  const assistant = useAssistant();
  const inviteCode = useMemo(readInviteCode, []);
  const shell = useRef<HTMLElement | null>(null);

  // What the visitor is doing; null while the lens runs its own loop.
  const [activity, setActivity] = useState<Exclude<AccountFormActivity, "idle"> | null>(null);
  const release = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const onActivity = useCallback((next: AccountFormActivity) => {
    clearTimeout(release.current);
    if (next === "idle") {
      setActivity(null);
      return;
    }
    setActivity(next);
    if (next !== "busy") {
      release.current = setTimeout(() => setActivity(null), next === "typing" ? TYPING_HOLD_MS : ERROR_HOLD_MS);
    }
  }, []);
  useEffect(() => () => clearTimeout(release.current), []);

  const phrases = useMemo(
    () =>
      (["login.phrase1", "login.phrase2", "login.phrase3", "login.phrase4"] as const).map((key) =>
        t(key, { name: assistant.name })
      ),
    [t, assistant.name]
  );
  const demo = useLoginDemo(phrases, activity !== null);
  const phrase = phrases[demo.phrase % phrases.length] ?? "";

  // The character: the visitor's activity wins over the loop.
  let mood: MascotMood = "ready";
  if (activity === "error") mood = "alert";
  else if (activity === "busy") mood = "thinking";
  else if (activity === "typing") mood = "listening";
  else if (demo.stage === "hearing" && demo.shown > 0) mood = "listening";
  else if (demo.stage === "thinking") mood = "thinking";
  else if (demo.stage === "speaking") mood = "speaking";

  // A soft light follows the pointer. It is written straight to the element:
  // re-rendering the page on every pointer move would be wasted work.
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === "touch") return;
    const node = shell.current;
    if (!node) return;
    const bounds = node.getBoundingClientRect();
    node.style.setProperty("--login-x", `${event.clientX - bounds.left}px`);
    node.style.setProperty("--login-y", `${event.clientY - bounds.top}px`);
  };

  const hint = !authEnabled
    ? t("login.firstUse")
    : inviteCode
      ? t("login.invite")
      : registrationOpen
        ? t("login.openRegistration")
        : t("login.closedRegistration");

  return (
    <main className="loginShell" ref={shell} onPointerMove={onPointerMove}>
      <div className="loginAmbient" aria-hidden="true">
        <span className="loginAurora a" />
        <span className="loginAurora b" />
        <span className="loginGrid" />
        <span className="loginPointer" />
      </div>
      <header className="loginTop">
        <BrandMark className="loginMark" />
        <strong>{assistant.name}</strong>
        <LanguageToggle />
      </header>
      <div className="loginStage">
        <section className="loginHero">
          <Mascot className="loginMascot" mood={mood} followCursor restOver=".loginCard" />
          <h1>{t("login.welcome", { product: assistant.name })}</h1>
          <p className="loginTagline">
            {assistant.tagline || deviceAssistantCopy(t, language, "voice.assistantKind", assistant)}
          </p>
          <p className={`loginPhrase ${demo.stage}`} aria-hidden="true">
            <span className="loginPhraseDot" />
            <span className="loginPhraseText">
              {phrase.slice(0, demo.shown)}
              <i className="loginCaret" />
            </span>
          </p>
        </section>
        <section className="loginGate" aria-label={t("login.aria")}>
          <div className={`loginCard${activity === "error" ? " refused" : ""}`}>
            <p className="loginEyebrow">
              <span className="loginEyebrowDot" />
              {t("login.platform")}
            </p>
            <p className="loginHint">{hint}</p>
            <AccountForm
              key={`${authEnabled}-${inviteCode}`}
              authEnabled={authEnabled}
              registrationOpen={registrationOpen}
              inviteCode={inviteCode || undefined}
              onActivity={onActivity}
              onSignedIn={(user) => {
                if (inviteCode) clearInviteFromUrl();
                onSignedIn(user);
              }}
            />
          </div>
          {assistant.developer ? <p className="loginFootnote">{assistant.developer}</p> : null}
          <p className="loginFootnote loginContact">
            {localized(language, "需要账号或帮助？", "Need an account or help? ")}
            <a href={contactUrl("Max account")}>{CONTACT_EMAIL}</a>
          </p>
        </section>
      </div>
    </main>
  );
}
