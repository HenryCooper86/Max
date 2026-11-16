// Account UI building blocks. AccountForm remains the full-screen LoginGate's
// login/registration form. AccountSessionControls is the authenticated user's
// profile controls shared by Testing and Administration.

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
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
import { useAssistant } from "./AssistantContext";
import { useLanguage } from "./LanguageToggle";
import { localized } from "../lib/i18n";

type FormProps = {
  authEnabled: boolean;
  registrationOpen: boolean;
  /** A single-use invite code (?invite=…) unlocks registration even when
   *  self-registration is closed. */
  inviteCode?: string;
  onSignedIn: (user: AuthUser) => void;
};

/** What the form is doing, for a surface that wants to react to it (the
 *  sign-in page's lens): a keystroke, a request in flight, a refusal. */
export type AccountFormActivity = "typing" | "busy" | "error" | "idle";

function FieldIcon({ kind }: { kind: "user" | "lock" | "tag" }) {
  return (
    <svg className="accountFieldIcon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      {kind === "user" ? (
        <path d="M10 10.2a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8ZM3.6 16.6c.7-2.6 3.2-4 6.4-4s5.7 1.4 6.4 4" />
      ) : kind === "lock" ? (
        <path d="M5.2 9h9.6c.6 0 1 .4 1 1v5.6c0 .6-.4 1-1 1H5.2c-.6 0-1-.4-1-1V10c0-.6.4-1 1-1Zm1.6 0V6.6a3.2 3.2 0 0 1 6.4 0V9" />
      ) : (
        <path d="M3.4 4.4c0-.6.4-1 1-1h5.2l7 7-6.2 6.2-7-7V4.4Zm3.4 2.4h.01" />
      )}
    </svg>
  );
}

export function AccountForm({
  authEnabled,
  registrationOpen,
  inviteCode,
  onSignedIn,
  onActivity
}: FormProps & { onActivity?: (activity: AccountFormActivity) => void }) {
  const { t } = useLanguage();
  const canRegister = registrationOpen || Boolean(inviteCode);
  const [mode, setMode] = useState<"login" | "register">(authEnabled && !inviteCode ? "login" : "register");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Counts refusals so the same message shown twice still replays its motion.
  const [attempt, setAttempt] = useState(0);

  const registering = mode === "register" && canRegister;
  const typed = (set: (value: string) => void) => (event: ChangeEvent<HTMLInputElement>) => {
    set(event.target.value);
    onActivity?.("typing");
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    onActivity?.("busy");
    const request = registering
      ? registerAccount(username, password, displayName || undefined, inviteCode)
      : loginAccount(username, password);
    void request
      .then((result) => {
        if (result.ok) {
          setPassword("");
          onActivity?.("idle");
          onSignedIn(result.user);
        } else {
          setError(result.error);
          setAttempt((count) => count + 1);
          onActivity?.("error");
        }
      })
      .finally(() => setBusy(false));
  };

  return (
    <form className="accountForm" aria-label={t("account.loginOrRegister")} aria-busy={busy} onSubmit={submit}>
      <div className="accountFields">
        <label className="accountField">
          <FieldIcon kind="user" />
          <input
            value={username}
            onChange={typed(setUsername)}
            placeholder=" "
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
          />
          <span className="accountFieldLabel">{t("account.username")}</span>
        </label>
        <label className="accountField hasToggle">
          <FieldIcon kind="lock" />
          <input
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={typed(setPassword)}
            placeholder=" "
            autoComplete={registering ? "new-password" : "current-password"}
            autoCapitalize="none"
            spellCheck={false}
            required
          />
          <span className="accountFieldLabel">{registering ? t("account.passwordMin") : t("account.password")}</span>
          <button
            type="button"
            className="accountReveal"
            aria-pressed={showPassword}
            aria-label={showPassword ? t("account.hidePassword") : t("account.showPassword")}
            onClick={() => setShowPassword((shown) => !shown)}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
              <path d="M2.2 10s2.8-5 7.8-5 7.8 5 7.8 5-2.8 5-7.8 5-7.8-5-7.8-5Z" />
              <circle cx="10" cy="10" r="2.3" />
              {showPassword ? null : <path d="M4 16 16 4" />}
            </svg>
          </button>
        </label>
        {registering ? (
          <label className="accountField accountFieldEnter">
            <FieldIcon kind="tag" />
            <input
              value={displayName}
              onChange={typed(setDisplayName)}
              placeholder=" "
              autoComplete="nickname"
              spellCheck={false}
            />
            <span className="accountFieldLabel">{t("account.displayName")}</span>
          </label>
        ) : null}
      </div>
      {error ? (
        <p key={attempt} className="accountError" role="alert">
          {error}
        </p>
      ) : null}
      <div className="accountActions">
        <button type="submit" className={busy ? "busy" : undefined} disabled={busy}>
          <span>{busy ? t("account.working") : registering ? t("account.register") : t("account.login")}</span>
          {busy ? (
            <span className="accountSpinner" aria-hidden="true" />
          ) : (
            <svg className="accountArrow" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
              <path d="M4 10h11m-4.5-4.5L15 10l-4.5 4.5" />
            </svg>
          )}
        </button>
        {canRegister ? (
          <button type="button" className="accountSwitch" onClick={() => setMode(registering ? "login" : "register")}>
            {registering
              ? t("account.haveAccount")
              : authEnabled
                ? t("account.registerNew")
                : t("account.registerAdmin")}
          </button>
        ) : null}
      </div>
    </form>
  );
}

function PasswordChangeForm({ onDone }: { onDone: (changed: boolean) => void }) {
  const { t } = useLanguage();
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
          setError(result.error ?? t("account.passwordChangeFailed"));
        }
      })
      .finally(() => {
        if (mountedRef.current) setBusy(false);
      });
  };

  return (
    <form className="accountForm passwordForm" aria-label={t("account.changePasswordAria")} onSubmit={submit}>
      <div className="accountFields">
        <input
          type="password"
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
          placeholder={t("account.currentPassword")}
          autoComplete="current-password"
          required
        />
        <input
          type="password"
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          placeholder={t("account.newPassword")}
          autoComplete="new-password"
          required
        />
      </div>
      <div className="accountActions">
        <button type="submit" disabled={busy}>
          {busy ? t("account.changingPassword") : t("account.confirmPassword")}
        </button>
        <button type="button" className="accountSwitch" onClick={() => onDone(false)}>
          {t("account.cancel")}
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

type SessionControlsProps = { user: AuthUser; onSignedOut: () => void; showConnectionToken?: boolean };

export function AccountSessionControls(props: SessionControlsProps) {
  return <AccountSessionControlsForUser key={props.user.id} {...props} />;
}

function AccountSessionControlsForUser({ user, onSignedOut, showConnectionToken = false }: SessionControlsProps) {
  const { language, t } = useLanguage();
  const assistant = useAssistant();
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
    <div className="accountBar" aria-label={t("account.loginOrRegister")}>
      <div className="accountIdentity">
        <strong>{user.displayName}</strong>
        <span>
          @{user.username} ·{" "}
          {user.role === "admin"
            ? t("account.roleAdmin")
            : user.role === "reviewer"
              ? t("account.roleReviewer")
              : t("account.roleTester")}
        </span>
      </div>
      <div className="accountActions">
        {showConnectionToken ? (
          <button
            type="button"
            className="accountSwitch"
            title={localized(
              language,
              "复制会话令牌，粘贴到 iOS/Android App 中连接",
              "Copy the session token and paste it into the iOS/Android app to connect"
            )}
            onClick={() => {
              const ownerId = user.id;
              const sequence = ++copySequenceRef.current;
              setClipboardNotice(null);
              void copyToClipboard(authToken()).then((ok) => {
                if (!mountedRef.current || currentUserRef.current !== ownerId || copySequenceRef.current !== sequence) {
                  return;
                }
                setCopied(ok);
                if (!ok) setClipboardNotice(t("account.copyFailed"));
              });
            }}
          >
            {copied ? t("account.copied") : t("account.copyToken")}
          </button>
        ) : null}
        <button
          type="button"
          className="accountSwitch"
          onClick={() => {
            setChangingPassword((open) => !open);
            setPasswordChanged(false);
          }}
        >
          {passwordChanged ? t("account.passwordChanged") : t("account.changePassword")}
        </button>
        <button
          type="button"
          className={`danger ${memoryClearArmed ? "armed" : ""}`}
          disabled={memoryBusy || !memorySummary?.turnCount}
          title={t("account.memoryHelp", { name: assistant.name })}
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
                setMemoryNotice(ok ? t("account.memoryCleared") : t("account.memoryClearFailed"));
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
            ? t("account.confirmMemoryClear")
            : memorySummary
              ? t("account.memorySummary", {
                  turns: memorySummary.turnCount,
                  facts: memorySummary.factCount ? ` · ${memorySummary.factCount} ${t("account.memoryFactSuffix")}` : ""
                })
              : t("account.memory")}
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
          {t("account.logout")}
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
