// Account UI building blocks. AccountForm is the login/registration form,
// shared by the full-screen LoginGate (site-wide access) and the testing
// panel's AccountBar (bootstrap registration of the very first account, and
// the logged-in identity chip with logout).

import { useState, type FormEvent } from "react";
import {
  authToken,
  changePasswordAccount,
  loginAccount,
  logoutAccount,
  registerAccount,
  type AuthUser
} from "../lib/auth";

type FormProps = {
  authEnabled: boolean;
  registrationOpen: boolean;
  /** A single-use invite code (?invite=…) unlocks registration even when
   *  self-registration is closed. */
  inviteCode?: string;
  onSignedIn: (user: AuthUser) => void;
};

export function AccountForm({ authEnabled, registrationOpen, inviteCode, onSignedIn }: FormProps) {
  const canRegister = registrationOpen || Boolean(inviteCode);
  const [mode, setMode] = useState<"login" | "register">(authEnabled && !inviteCode ? "login" : "register");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const registering = mode === "register" && canRegister;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const request = registering
      ? registerAccount(username, password, displayName || undefined, inviteCode)
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
        {canRegister ? (
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

function PasswordChangeForm({ onDone }: { onDone: (changed: boolean) => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    void changePasswordAccount(currentPassword, newPassword)
      .then((result) => {
        if (result.ok) {
          onDone(true);
        } else {
          setError(result.error ?? "修改失败，请重试。");
        }
      })
      .finally(() => setBusy(false));
  };

  return (
    <form className="accountForm passwordForm" aria-label="修改密码" onSubmit={submit}>
      <div className="accountFields">
        <input
          type="password"
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
          placeholder="当前密码"
          autoComplete="current-password"
          required
        />
        <input
          type="password"
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          placeholder="新密码（至少 8 位）"
          autoComplete="new-password"
          required
        />
      </div>
      <div className="accountActions">
        <button type="submit" disabled={busy}>
          {busy ? "修改中…" : "确认修改"}
        </button>
        <button type="button" className="accountSwitch" onClick={() => onDone(false)}>
          取消
        </button>
      </div>
      {error ? (
        <p className="accountError" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

export function AccountBar({ authEnabled, registrationOpen, user, onSignedIn, onSignedOut }: BarProps) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [passwordChanged, setPasswordChanged] = useState(false);

  if (user) {
    return (
      <div className="accountBar" aria-label="账号">
        <div className="accountIdentity">
          <strong>{user.displayName}</strong>
          <span>
            @{user.username} · {user.role === "admin" ? "管理员" : user.role === "reviewer" ? "审核员" : "测试员"}
          </span>
        </div>
        <div className="accountActions">
          <button
            type="button"
            className="accountSwitch"
            title="复制会话令牌，粘贴到 iOS/Android App 的认证令牌栏即可连接"
            onClick={() => {
              void navigator.clipboard?.writeText(authToken()).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 2000);
              });
            }}
          >
            {copied ? "已复制 ✓" : "复制令牌（App 用）"}
          </button>
          <button
            type="button"
            className="accountSwitch"
            onClick={() => {
              setChangingPassword((open) => !open);
              setPasswordChanged(false);
            }}
          >
            {passwordChanged ? "密码已修改 ✓" : "修改密码"}
          </button>
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
        {changingPassword ? (
          <PasswordChangeForm
            onDone={(changed) => {
              setChangingPassword(false);
              if (changed) {
                setPasswordChanged(true);
                window.setTimeout(() => setPasswordChanged(false), 3000);
              }
            }}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="accountBar">
      <AccountForm authEnabled={authEnabled} registrationOpen={registrationOpen} onSignedIn={onSignedIn} />
    </div>
  );
}
