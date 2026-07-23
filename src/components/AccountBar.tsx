// Account UI building blocks. AccountForm remains the full-screen LoginGate's
// login/registration form. AccountSessionControls is the authenticated user's
// identity, security, memory, and logout footer in the Admin workspace.

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  authToken,
  changePasswordAccount,
  fetchUserMemorySummary,
  forgetUserMemory,
  loginAccount,
  logoutAccount,
  registerAccount,
  type AuthUser,
  type UserMemorySummary
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

function PasswordChangeForm({ onDone }: { onDone: (changed: boolean) => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    void changePasswordAccount(currentPassword, newPassword)
      .then((result) => {
        if (!mountedRef.current) return;
        if (result.ok) {
          onDone(true);
        } else {
          setError(result.error ?? "修改失败，请重试。");
        }
      })
      .finally(() => {
        if (mountedRef.current) setBusy(false);
      });
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

async function copyToClipboard(value: string): Promise<boolean> {
  if (!navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

type SessionControlsProps = { user: AuthUser; onSignedOut: () => void };

export function AccountSessionControls(props: SessionControlsProps) {
  return <AccountSessionControlsForUser key={props.user.id} {...props} />;
}

function AccountSessionControlsForUser({ user, onSignedOut }: SessionControlsProps) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [passwordChanged, setPasswordChanged] = useState(false);
  const [memorySummary, setMemorySummary] = useState<UserMemorySummary | null>(null);
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [memoryClearArmed, setMemoryClearArmed] = useState(false);
  const [memoryNotice, setMemoryNotice] = useState<string | null>(null);
  const [clipboardNotice, setClipboardNotice] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const currentUserRef = useRef(user.id);
  const copySequenceRef = useRef(0);
  const memorySequenceRef = useRef(0);
  const logoutSequenceRef = useRef(0);
  const signedOutRef = useRef(onSignedOut);
  currentUserRef.current = user.id;
  signedOutRef.current = onSignedOut;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      copySequenceRef.current += 1;
      memorySequenceRef.current += 1;
    };
  }, []);

  useEffect(() => {
    const ownerId = user.id;
    let active = true;
    let requestSequence = 0;
    setMemorySummary(null);
    const refresh = () => {
      const sequence = ++requestSequence;
      void fetchUserMemorySummary().then((summary) => {
        if (active && mountedRef.current && currentUserRef.current === ownerId && sequence === requestSequence) {
          setMemorySummary(summary);
        }
      });
    };
    const refreshWhenVisible = () => {
      if (!document.hidden) refresh();
    };
    refresh();
    // A once-per-login snapshot made the badge look broken even while the
    // server was saving turns. Keep this lightweight metadata honest during a
    // long ride and refresh immediately when the rider returns to the tab.
    const timer = window.setInterval(refreshWhenVisible, 15_000);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [user.id]);

  useEffect(() => {
    if (!memoryClearArmed) return;
    const timer = window.setTimeout(() => setMemoryClearArmed(false), 4000);
    return () => window.clearTimeout(timer);
  }, [memoryClearArmed]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    if (!passwordChanged) return;
    const timer = window.setTimeout(() => setPasswordChanged(false), 3000);
    return () => window.clearTimeout(timer);
  }, [passwordChanged]);

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
            const ownerId = user.id;
            const sequence = ++copySequenceRef.current;
            setClipboardNotice(null);
            void copyToClipboard(authToken()).then((ok) => {
              if (!mountedRef.current || currentUserRef.current !== ownerId || copySequenceRef.current !== sequence) {
                return;
              }
              setCopied(ok);
              if (!ok) setClipboardNotice("无法复制会话令牌。");
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
          className={`danger ${memoryClearArmed ? "armed" : ""}`}
          disabled={memoryBusy || !memorySummary?.turnCount}
          title="清除 Max 为当前登录用户保存的跨会话记忆"
          onClick={() => {
            if (!memoryClearArmed) {
              setMemoryClearArmed(true);
              setMemoryNotice(null);
              return;
            }
            const ownerId = user.id;
            const sequence = ++memorySequenceRef.current;
            setMemoryBusy(true);
            setMemoryClearArmed(false);
            void forgetUserMemory()
              .then((ok) => {
                if (
                  !mountedRef.current ||
                  currentUserRef.current !== ownerId ||
                  memorySequenceRef.current !== sequence
                ) {
                  return;
                }
                setMemoryNotice(ok ? "记忆已清除 ✓" : "清除记忆失败");
                if (ok) {
                  setMemorySummary((summary) => (summary ? { ...summary, turnCount: 0, factCount: 0 } : summary));
                }
              })
              .finally(() => {
                if (
                  mountedRef.current &&
                  currentUserRef.current === ownerId &&
                  memorySequenceRef.current === sequence
                ) {
                  setMemoryBusy(false);
                }
              });
          }}
        >
          {memoryClearArmed
            ? "确认清除记忆?"
            : memorySummary
              ? `记忆 ${memorySummary.turnCount} 段${memorySummary.factCount ? ` · ${memorySummary.factCount} 条重点` : ""}`
              : "记忆…"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            const ownerId = user.id;
            const sequence = ++logoutSequenceRef.current;
            setBusy(true);
            const request = logoutAccount();
            signedOutRef.current();
            void request.finally(() => {
              if (mountedRef.current && currentUserRef.current === ownerId && logoutSequenceRef.current === sequence) {
                setBusy(false);
              }
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
            if (changed) setPasswordChanged(true);
          }}
        />
      ) : null}
      {clipboardNotice ? (
        <p className="accountMemoryNotice" role="alert">
          {clipboardNotice}
        </p>
      ) : null}
      {memoryNotice ? (
        <p className="accountMemoryNotice" role={memoryNotice.includes("失败") ? "alert" : "status"}>
          {memoryNotice}
        </p>
      ) : null}
    </div>
  );
}
