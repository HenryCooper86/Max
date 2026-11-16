// Full-screen access gate: the login page always comes first, like a normal
// authenticated web app. On a fresh relay it offers first-run (admin)
// registration; an ?invite=… link unlocks registration for a new tester even
// while self-registration is closed. The relay refuses anonymous /agent
// connections once accounts exist, so this is enforcement, not decoration.

import { useMemo } from "react";
import type { AuthUser } from "../lib/auth";
import { deviceCopyKey } from "../lib/i18n";
import { AccountForm } from "./AccountBar";
import { useAssistant } from "./AssistantContext";
import { LanguageToggle, useLanguage } from "./LanguageToggle";
import { VisorMark } from "./VisorVisual";

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

export function LoginGate({ authEnabled, registrationOpen, onSignedIn }: Props) {
  const { t } = useLanguage();
  const assistant = useAssistant();
  const inviteCode = useMemo(readInviteCode, []);

  const hint = !authEnabled
    ? t("login.firstUse")
    : inviteCode
      ? t("login.invite")
      : registrationOpen
        ? t("login.openRegistration")
        : t("login.closedRegistration");

  return (
    <main className="loginShell">
      <section className="loginGate" aria-label={t("login.aria")}>
        <header className="loginBrand">
          <VisorMark className="loginMark" />
          <div>
            <h1>{assistant.name}</h1>
            <p>{assistant.tagline || t(deviceCopyKey("voice.assistantKind", assistant.device))}</p>
          </div>
          <LanguageToggle />
        </header>
        <div className="loginCard">
          <h2>{t("login.platform")}</h2>
          <p className="loginHint">{hint}</p>
          <AccountForm
            key={`${authEnabled}-${inviteCode}`}
            authEnabled={authEnabled}
            registrationOpen={registrationOpen}
            inviteCode={inviteCode || undefined}
            onSignedIn={(user) => {
              if (inviteCode) clearInviteFromUrl();
              onSignedIn(user);
            }}
          />
        </div>
        {assistant.developer ? <p className="loginFootnote">{assistant.developer}</p> : null}
      </section>
    </main>
  );
}
