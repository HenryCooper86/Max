import { useState, type FormEvent } from "react";
import { ApiError, type CloudApi } from "./api";
import { useSay } from "./hooks";

type Mode = "signup" | "login";
const MIN_PASSWORD_LENGTH = 10;

/** One card: Create account / Log in. */
export function AuthCard({
  api,
  onSignedIn,
  initialMode = "signup"
}: {
  api: CloudApi;
  onSignedIn: (token: string) => void;
  initialMode?: Mode;
}) {
  const say = useSay();
  const [mode, setMode] = useState<Mode>(initialMode);
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
      const result = await (mode === "signup" ? api.signup(email.trim(), password) : api.login(email.trim(), password));
      onSignedIn(result.token);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : say("出错了，请重试。", "Something went wrong. Try again.")
      );
      setBusy(false);
    }
  };

  return (
    <section className="cxCard cxAuth" aria-labelledby="cx-auth-title">
      <h1 id="cx-auth-title">{say("Max Cloud 控制台", "Max Cloud console")}</h1>
      <p className="cxReassure">
        {say(
          "每月 1,000 分钟免费。使用你自己的 OpenAI、Gemini 或 xAI 密钥。",
          "1,000 free minutes every month. Bring your own OpenAI, Gemini or xAI key."
        )}
      </p>
      <div className="cxTabs" role="tablist" aria-label={say("账户", "Account")}>
        {(["signup", "login"] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            id={`cx-tab-${value}`}
            aria-selected={mode === value}
            aria-controls="cx-auth-panel"
            className={mode === value ? "active" : undefined}
            onClick={() => {
              setMode(value);
              setError("");
            }}
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
