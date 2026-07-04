// Full-screen access gate: the login page always comes first, like a normal
// authenticated web app. On a fresh relay it offers first-run (admin)
// registration; an ?invite=… link unlocks registration for a new tester even
// while self-registration is closed. The relay refuses anonymous /agent
// connections once accounts exist, so this is enforcement, not decoration.

import { useMemo } from "react";
import type { AuthUser } from "../lib/auth";
import { AccountForm } from "./AccountBar";

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
  const inviteCode = useMemo(readInviteCode, []);

  const hint = !authEnabled
    ? "首次使用：注册第一个账号，该账号将成为管理员。"
    : inviteCode
      ? "你收到了一个邀请 — 注册你的测试账号即可进入。"
      : registrationOpen
        ? "登录后进入语音测试座舱；没有账号可以注册（需管理员知晓）。"
        : "登录后进入语音测试座舱。注册已关闭 — 需要账号请联系管理员。";

  return (
    <main className="shell loginShell">
      <div className="loginBackdrop" aria-hidden="true">
        <span className="loginOrb orbA" />
        <span className="loginOrb orbB" />
        <span className="loginGrid" />
        <span className="loginHorizon" />
      </div>
      <section className="loginGate" aria-label="登录">
        <div className="brand loginBrand">
          <svg className="logoMark loginLogo" viewBox="0 0 44 44" aria-hidden="true">
            <path className="logoShell" d="M8 24a14 14 0 0 1 28 0v4a4 4 0 0 1-4 4H12a4 4 0 0 1-4-4Z" />
            <rect className="logoVisor" x="13" y="18" width="22" height="7" rx="3.5" />
          </svg>
          <div>
            <p className="eyebrow loginEyebrow">HCT HELMET OS</p>
            <h1>Max 摩托车头盔 AI</h1>
          </div>
        </div>
        <div className="loginCard">
          <span className="loginScanline" aria-hidden="true" />
          <div className="loginCardHead">
            <h2>内部测试平台</h2>
            <span className="loginStatusDot" aria-hidden="true" />
          </div>
          <p className="loginHint">{hint}</p>
          <AccountForm
            authEnabled={authEnabled}
            registrationOpen={registrationOpen}
            inviteCode={inviteCode || undefined}
            onSignedIn={(user) => {
              if (inviteCode) clearInviteFromUrl();
              onSignedIn(user);
            }}
          />
          <p className="loginFootnote">HORIZON CONTINENTAL TECHNOLOGY · SECURE ACCESS</p>
        </div>
      </section>
    </main>
  );
}
