import { useState, type FormEvent, type KeyboardEvent } from "react";
import { INVITE_REQUEST_URL } from "../lib/pricing";
import { ApiError, type CloudApi } from "./api";
import { useSay } from "./hooks";

type Mode = "signup" | "login";
const MODES: readonly Mode[] = ["signup", "login"];
const MIN_PASSWORD_LENGTH = 10;

/** The invitation code in the page address (`/console?invite=cinv_…`), if any. */
export function inviteFromLocation(search: string): string {
  const code = new URLSearchParams(search).get("invite")?.trim() ?? "";
  return /^cinv_[0-9a-f]{32}$/.test(code) ? code : "";
}

/** One card: Create account (by invitation) / Log in. */
export function AuthCard({
  api,
  onSignedIn,
  invite: initialInvite = ""
}: {
  api: CloudApi;
  onSignedIn: (token: string) => void;
  /** From the invitation link; opens the card on Create account. */
  invite?: string;
}) {
  const say = useSay();
  const [mode, setMode] = useState<Mode>(initialInvite ? "signup" : "login");
  const [invite, setInvite] = useState(initialInvite);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (mode === "signup" && password.length < MIN_PASSWORD_LENGTH) {
      setError(
        say(`密码至少 ${MIN_PASSWORD_LENGTH} 个字符。`, `Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`)
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await (mode === "signup"
        ? api.signup(email.trim(), password, invite.trim())
        : api.login(email.trim(), password));
      onSignedIn(result.token);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : say("出错了，请重试。", "Something went wrong. Try again.")
      );
      setBusy(false);
    }
  };

  const chooseMode = (value: Mode) => {
    setMode(value);
    setError("");
  };

  // The WAI-ARIA tabs pattern: the arrow keys and Home/End move to another
  // tab and select it. Only the selected tab is in the Tab order.
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = MODES.length - 1;
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % MODES.length
        : event.key === "ArrowLeft"
          ? (index + last) % MODES.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    chooseMode(MODES[next]!);
    document.getElementById(`cx-tab-${MODES[next]}`)?.focus();
  };

  return (
    <section className="cxCard cxAuth" aria-labelledby="cx-auth-title">
      <h1 id="cx-auth-title">{say("Max Cloud 控制台", "Max Cloud console")}</h1>
      <p className="cxReassure">
        {say(
          "抢先体验期间凭邀请注册。每月 1,000 分钟免费，使用你自己的 OpenAI、Gemini 或 xAI 密钥。",
          "Early access is by invitation. 1,000 free minutes every month; bring your own OpenAI, Gemini or xAI key."
        )}
      </p>
      <div className="cxTabs" role="tablist" aria-label={say("账户", "Account")}>
        {MODES.map((value, index) => (
          <button
            key={value}
            type="button"
            role="tab"
            id={`cx-tab-${value}`}
            aria-selected={mode === value}
            aria-controls="cx-auth-panel"
            tabIndex={mode === value ? 0 : -1}
            className={mode === value ? "active" : undefined}
            onClick={() => chooseMode(value)}
            onKeyDown={(event) => onTabKey(event, index)}
          >
            {value === "signup" ? say("创建账户", "Create account") : say("登录", "Log in")}
          </button>
        ))}
      </div>
      <form
        id="cx-auth-panel"
        role="tabpanel"
        aria-labelledby={`cx-tab-${mode}`}
        onSubmit={(event) => void submit(event)}
      >
        {mode === "signup" ? (
          <label className="cxField">
            <span>{say("邀请码", "Invitation code")}</span>
            <input
              type="text"
              required
              autoComplete="off"
              spellCheck={false}
              placeholder="cinv_…"
              aria-describedby="cx-invite-hint"
              value={invite}
              onChange={(event) => setInvite(event.target.value)}
            />
            <small id="cx-invite-hint">
              {initialInvite
                ? say("已从你的邀请链接填好。", "Filled in from your invitation link.")
                : say("没有邀请？", "No invitation yet?")}{" "}
              {initialInvite ? null : (
                <a className="siteTextLink" href={INVITE_REQUEST_URL}>
                  {say("申请邀请", "Request one")}
                </a>
              )}
            </small>
          </label>
        ) : null}
        <label className="cxField">
          <span>{say("邮箱", "Email")}</span>
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label className="cxField">
          <span>{say("密码", "Password")}</span>
          <input
            type="password"
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            required
            minLength={mode === "signup" ? MIN_PASSWORD_LENGTH : undefined}
            aria-describedby={mode === "signup" ? "cx-password-hint" : undefined}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          {mode === "signup" ? (
            <small id="cx-password-hint">{say("至少 10 个字符。", "At least 10 characters.")}</small>
          ) : null}
        </label>
        <p className="cxError" aria-live="polite">
          {error}
        </p>
        <button className="siteButton" type="submit" disabled={busy}>
          {mode === "signup" ? say("创建账户", "Create account") : say("登录", "Log in")}
        </button>
      </form>
    </section>
  );
}
