// Full-screen access gate: once any user account exists on the relay, the
// whole HUD stays hidden behind this login page (and the relay itself refuses
// anonymous /agent connections), so only people with an account can use the
// site — like a normal authenticated web app.

import type { AuthUser } from "../lib/auth";
import { AccountForm } from "./AccountBar";

type Props = {
  registrationOpen: boolean;
  onSignedIn: (user: AuthUser) => void;
};

export function LoginGate({ registrationOpen, onSignedIn }: Props) {
  return (
    <main className="shell loginShell">
      <section className="loginGate" aria-label="登录">
        <div className="brand loginBrand">
          <svg className="logoMark" viewBox="0 0 44 44" aria-hidden="true">
            <path className="logoShell" d="M8 24a14 14 0 0 1 28 0v4a4 4 0 0 1-4 4H12a4 4 0 0 1-4-4Z" />
            <rect className="logoVisor" x="13" y="18" width="22" height="7" rx="3.5" />
          </svg>
          <div>
            <p className="eyebrow">HCT Helmet OS</p>
            <h1>Max 摩托车头盔 AI</h1>
          </div>
        </div>
        <div className="loginCard">
          <h2>内部测试平台</h2>
          <p className="loginHint">
            {registrationOpen
              ? "登录后进入语音测试座舱；没有账号可以注册（需管理员知晓）。"
              : "登录后进入语音测试座舱。注册已关闭 — 需要账号请联系管理员。"}
          </p>
          <AccountForm authEnabled registrationOpen={registrationOpen} onSignedIn={onSignedIn} />
        </div>
      </section>
    </main>
  );
}
