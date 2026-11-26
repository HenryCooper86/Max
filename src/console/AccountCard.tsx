import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError } from "./api";
import { useSay, type Session } from "./hooks";

const MIN_PASSWORD_LENGTH = 10;

/**
 * The signed-in customer's account: who they are, their password, and every
 * device they are signed in on.
 */
export function AccountCard({
  session,
  email,
  onSignedOut
}: {
  session: Session;
  /** The customer's email, once it has loaded. */
  email: string | null;
  /** Every session of the customer has ended, this one included. */
  onSignedOut: () => void;
}) {
  const say = useSay();
  const { api, token, fail } = session;
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [passwordChanged, setPasswordChanged] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [signOutError, setSignOutError] = useState("");
  const [busy, setBusy] = useState(false);
  const signOutToggle = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  // The confirm step opens with the focus on its safe choice, so a keyboard user is never left on the page behind it.
  useEffect(() => {
    if (confirming) cancelButton.current?.focus();
  }, [confirming]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPasswordChanged(false);
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setPasswordError(
        say(`密码至少 ${MIN_PASSWORD_LENGTH} 个字符。`, `Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`)
      );
      return;
    }
    setBusy(true);
    setPasswordError("");
    try {
      await api.changePassword(token, currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setPasswordChanged(true);
    } catch (caught) {
      setPasswordError(
        caught instanceof ApiError ? fail(caught) : say("出错了，请重试。", "Something went wrong. Try again.")
      );
    } finally {
      setBusy(false);
    }
  };

  const cancelSignOut = () => {
    setConfirming(false);
    signOutToggle.current?.focus();
  };

  const signOutEverywhere = async () => {
    setBusy(true);
    setSignOutError("");
    try {
      await api.logoutEverywhere(token);
      onSignedOut();
    } catch (caught) {
      setSignOutError(
        caught instanceof ApiError ? fail(caught) : say("出错了，请重试。", "Something went wrong. Try again.")
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="cxSection" id="account" aria-labelledby="cx-account">
      <h2 id="cx-account">{say("账户", "Account")}</h2>
      <p className="cxMuted">{email ? say(`已登录：${email}`, `Signed in as ${email}`) : "…"}</p>

      <form
        className="cxEditor cxSubsection"
        aria-labelledby="cx-password-title"
        onSubmit={(event) => void submit(event)}
      >
        <h3 id="cx-password-title">{say("修改密码", "Change password")}</h3>
        <p className="cxMuted">
          {say(
            "修改后，其他设备需要用新密码重新登录，这一台保持登录。",
            "Other devices then have to log in again with the new password. This one stays signed in."
          )}
        </p>
        <label className="cxField">
          <span>{say("当前密码", "Current password")}</span>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
        </label>
        <label className="cxField">
          <span>{say("新密码", "New password")}</span>
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            aria-describedby="cx-password-hint"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
          />
          <small id="cx-password-hint">{say("至少 10 个字符。", "At least 10 characters.")}</small>
        </label>
        <p className="cxError" aria-live="polite">
          {passwordError}
        </p>
        <p className="cxStatus" role="status">
          {passwordChanged ? say("密码已修改。", "Password changed.") : ""}
        </p>
        <button className="siteButton" type="submit" disabled={busy}>
          {say("修改密码", "Change password")}
        </button>
      </form>

      <div className="cxDanger cxSection cxSubsection">
        <button
          type="button"
          className="siteButton secondary small"
          aria-expanded={confirming}
          aria-controls="cx-sign-out-everywhere"
          ref={signOutToggle}
          onClick={() => {
            setConfirming(true);
            setSignOutError("");
          }}
        >
          {say("在所有设备上退出登录", "Sign out everywhere")}
        </button>
        {confirming ? (
          <div id="cx-sign-out-everywhere" role="group" aria-label={say("确认", "Confirm")}>
            <p>
              {say(
                "所有设备上的登录都会退出，包括这一台。如果怀疑账户被盗，请登录后修改密码。",
                "Every device is signed out, this one included. If you think someone else has your password, log in and change it."
              )}
            </p>
            <div className="cxRow">
              <button
                type="button"
                className="siteButton small cxDangerButton"
                disabled={busy}
                onClick={() => void signOutEverywhere()}
              >
                {say("是，全部退出", "Yes, sign out everywhere")}
              </button>
              <button type="button" className="siteButton quiet small" ref={cancelButton} onClick={cancelSignOut}>
                {say("取消", "Cancel")}
              </button>
            </div>
          </div>
        ) : null}
        <p className="cxError" aria-live="polite">
          {signOutError}
        </p>
      </div>
    </section>
  );
}
