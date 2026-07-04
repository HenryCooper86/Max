// Account UI building blocks. AccountForm is the login/registration form,
// shared by the full-screen LoginGate (site-wide access) and the testing
// panel's AccountBar (bootstrap registration of the very first account, and
// the logged-in identity chip with logout).

import { useState, type FormEvent } from "react";
import { loginAccount, logoutAccount, registerAccount, type AuthUser } from "../lib/auth";

type FormProps = {
  authEnabled: boolean;
  registrationOpen: boolean;
  onSignedIn: (user: AuthUser) => void;
};

export function AccountForm({ authEnabled, registrationOpen, onSignedIn }: FormProps) {
  const [mode, setMode] = useState<"login" | "register">(authEnabled ? "login" : "register");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const registering = mode === "register" && registrationOpen;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const request = registering
      ? registerAccount(username, password, displayName || undefined)
      : loginAccount(username, password);
    void request
      .then((result) => {
        if (result.ok) {
          setPassword("");
          onSignedIn(result.user);
        } else {
          setError(result.error);
        }
      })
      .finally(() => setBusy(false));
  };

  return (
    <form className="accountForm" aria-label="登录或注册" onSubmit={submit}>
      <div className="accountFields">
        <input
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          placeholder="用户名"
          autoComplete="username"
          spellCheck={false}
          required
        />
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder={registering ? "密码（至少 8 位）" : "密码"}
          autoComplete={registering ? "new-password" : "current-password"}
          required
        />
        {registering ? (
          <input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="显示名（可选）"
            autoComplete="nickname"
            spellCheck={false}
          />
        ) : null}
      </div>
      <div className="accountActions">
        <button type="submit" disabled={busy}>
          {registering ? "注册" : "登录"}
        </button>
        {registrationOpen ? (
          <button type="button" className="accountSwitch" onClick={() => setMode(registering ? "login" : "register")}>
            {registering ? "已有账号？登录" : authEnabled ? "注册新账号" : "注册第一个账号（管理员）"}
          </button>
        ) : null}
      </div>
      {error ? (
        <p className="accountError" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

type BarProps = FormProps & {
  user: AuthUser | null;
  onSignedOut: () => void;
};

export function AccountBar({ authEnabled, registrationOpen, user, onSignedIn, onSignedOut }: BarProps) {
  const [busy, setBusy] = useState(false);

  if (user) {
    return (
      <div className="accountBar" aria-label="账号">
        <div className="accountIdentity">
          <strong>{user.displayName}</strong>
          <span>
            @{user.username} · {user.role === "admin" ? "管理员" : "测试员"}
          </span>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void logoutAccount().finally(() => {
              setBusy(false);
              onSignedOut();
            });
          }}
        >
          退出登录
        </button>
      </div>
    );
  }

  return (
    <div className="accountBar">
      <AccountForm authEnabled={authEnabled} registrationOpen={registrationOpen} onSignedIn={onSignedIn} />
    </div>
  );
}
