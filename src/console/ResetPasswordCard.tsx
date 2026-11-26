import { useEffect, useRef, useState, type FormEvent } from "react";
import { CONSOLE_PATH } from "../lib/routes";
import { ApiError, type CloudApi } from "./api";
import { useSay } from "./hooks";

const MIN_PASSWORD_LENGTH = 10;
const RESET_TOKEN = /^mcr_[A-Za-z0-9_-]{43}$/;

/** True for `/console/reset`, the page a password-reset link opens, with or without a trailing slash. */
export function isResetPath(pathname: string): boolean {
  return pathname.replace(/\/+$/, "") === `${CONSOLE_PATH}/reset`;
}

/** The reset token in the page address (`/console/reset?token=mcr_…`); "" when there is none shaped like one. */
export function resetTokenFromLocation(search: string): string {
  const token = new URLSearchParams(search).get("token")?.trim() ?? "";
  return RESET_TOKEN.test(token) ? token : "";
}

/**
 * The page a password-reset link opens (made by `npm run cloud:reset-password`):
 * choose a new password with it. A link that is unknown, used or expired is
 * refused with one answer, as the relay refuses it, and offers nothing more.
 */
export function ResetPasswordCard({
  api,
  token,
  onError,
  onDone
}: {
  api: CloudApi;
  /** The link's token; "" when the address has none, which is refused without asking the relay. */
  token: string;
  /** Makes sense of a failed call, as every section's `fail` does. */
  onError: (error: unknown) => string;
  /** The password is set and every session of the customer has ended; `email` is the customer's. */
  onDone: (email: string) => void;
}) {
  const say = useSay();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // The relay's one answer (403) for an unknown, used or expired link.
  const [refused, setRefused] = useState(false);
  const refusalRef = useRef<HTMLParagraphElement>(null);
  const title = say("设置新密码", "Set a new password");

  // Refusing the link unmounts the focused submit button; leave the focus on the refusal, not the page behind it.
  useEffect(() => {
    if (refused) refusalRef.current?.focus();
  }, [refused]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(
        say(`密码至少 ${MIN_PASSWORD_LENGTH} 个字符。`, `Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`)
      );
      return;
    }
    if (password !== confirmation) {
      setError(say("两次输入的密码不一致。", "The two passwords don't match."));
      return;
    }
    setBusy(true);
    setError("");
    try {
      onDone((await api.resetPassword(token, password)).email);
    } catch (caught) {
      setRefused(caught instanceof ApiError && caught.status === 403);
      setError(
        caught instanceof ApiError ? onError(caught) : say("出错了，请重试。", "Something went wrong. Try again.")
      );
      setBusy(false);
    }
  };

  return (
    <section className="cxCard cxAuth" aria-labelledby="cx-reset-title">
      <h1 id="cx-reset-title">{title}</h1>
      {token && !refused ? (
        <>
          <p className="cxReassure">
            {say(
              "为你的 Max Cloud 账户选一个新密码。设置后，所有设备都要用新密码重新登录。",
              "Choose a new password for your Max Cloud account. Once it is set, every device has to log in again with it."
            )}
          </p>
          <form onSubmit={(event) => void submit(event)}>
            <label className="cxField">
              <span>{say("新密码", "New password")}</span>
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={MIN_PASSWORD_LENGTH}
                aria-describedby="cx-reset-password-hint"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <small id="cx-reset-password-hint">{say("至少 10 个字符。", "At least 10 characters.")}</small>
            </label>
            <label className="cxField">
              <span>{say("再输入一次新密码", "Repeat the new password")}</span>
              <input
                type="password"
                autoComplete="new-password"
                required
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </label>
            <p className="cxError" aria-live="polite">
              {error}
            </p>
            <button className="siteButton" type="submit" disabled={busy}>
              {title}
            </button>
          </form>
        </>
      ) : (
        <>
          <p className="cxError" role="alert" ref={refusalRef}>
            {say(
              "这个链接无效：可能已经用过，或者已过期。",
              "This link is not valid: it may have been used or have expired."
            )}
          </p>
          <p className="cxReassure">
            {say("需要新的链接，请联系运营这台 Max Cloud 的人。", "For a new link, ask whoever runs this Max Cloud.")}
          </p>
        </>
      )}
      <p className="cxReassure">
        <a className="siteTextLink" href={CONSOLE_PATH}>
          {say("返回登录", "Back to log in")}
        </a>
      </p>
    </section>
  );
}
