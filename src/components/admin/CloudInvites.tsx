import { useCallback, useEffect, useState } from "react";
import { cloudInviteApi, cloudInviteUrl, type CloudInvite } from "../../lib/auth";
import { useLanguage } from "../LanguageToggle";
import { localized } from "../../lib/i18n";
import { formatAdminRelativeTime } from "./admin-model";

/**
 * Max Cloud invitations. Signup at /console is invitation-only, like the
 * testing platform's accounts: an admin creates a single-use link (optionally
 * noting who it is for), sends it, and it stops working once used or after
 * 7 days.
 */
export function CloudInvites({ onAuthenticationExpired }: { onAuthenticationExpired?: () => void }) {
  const { language } = useLanguage();
  const say = (zh: string, en: string) => localized(language, zh, en);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [invites, setInvites] = useState<CloudInvite[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [armed, setArmed] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await cloudInviteApi.list();
    if (result.ok) {
      setEnabled(result.data.enabled);
      setInvites(result.data.invites);
    } else if (result.error.status === 401) onAuthenticationExpired?.();
    else setMessage(result.error.message);
  }, [onAuthenticationExpired]);

  useEffect(() => {
    void load();
  }, [load]);

  async function copy(code: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(cloudInviteUrl(code));
      return true;
    } catch {
      return false;
    }
  }

  async function create() {
    setBusy(true);
    setMessage("");
    const result = await cloudInviteApi.create(note);
    setBusy(false);
    if (!result.ok) {
      if (result.error.status === 401) onAuthenticationExpired?.();
      setMessage(result.error.message);
      return;
    }
    setNote("");
    const copied = await copy(result.data.code);
    setMessage(
      copied
        ? say("邀请链接已复制，发送给对方即可。", "Invitation link copied. Send it to them.")
        : `${say("请手动复制：", "Copy it manually: ")}${cloudInviteUrl(result.data.code)}`
    );
    await load();
  }

  async function revoke(code: string) {
    if (armed !== code) {
      setArmed(code);
      return;
    }
    setArmed(null);
    setBusy(true);
    await cloudInviteApi.revoke(code);
    setBusy(false);
    await load();
  }

  if (enabled === false) {
    return (
      <section className="adminAccountGroup" aria-label="Max Cloud">
        <h4 className="adminAccountGroupHead">{say("Max Cloud 邀请", "Max Cloud invitations")}</h4>
        <p className="testerConversationEmpty">
          {say("此服务器未开启 Max Cloud。", "Max Cloud is not enabled on this server.")}
        </p>
      </section>
    );
  }

  return (
    <section className="adminAccountGroup" aria-label={say("Max Cloud 邀请", "Max Cloud invitations")}>
      <h4 className="adminAccountGroupHead">
        {say("Max Cloud 邀请", "Max Cloud invitations")}
        <span>{invites.length}</span>
      </h4>
      <p className="testerConversationEmpty">
        {say(
          "Max Cloud 只能凭邀请注册。每个邀请链接只能用一次，7 天后失效。",
          "Max Cloud signup is by invitation. Each link works once and expires after 7 days."
        )}
      </p>
      <div className="accountAdminRow">
        <input
          type="text"
          value={note}
          maxLength={120}
          placeholder={say("备注：发给谁（可选）", "Note: who it is for (optional)")}
          aria-label={say("邀请备注", "Invitation note")}
          onChange={(event) => setNote(event.target.value)}
        />
        <button type="button" disabled={busy || enabled === null} onClick={() => void create()}>
          {busy ? say("正在生成…", "Generating…") : say("生成 Cloud 邀请链接", "Generate Cloud invitation")}
        </button>
      </div>
      <p aria-live="polite" className="testerConversationEmpty">
        {message}
      </p>
      {invites.map((invite) => (
        <div className="accountAdminRow" key={invite.code}>
          <div className="adminAccountUser">
            <strong>{invite.note || `${invite.code.slice(0, 13)}…`}</strong>
            <span>
              {say("创建者", "By")} {invite.createdBy} · {formatAdminRelativeTime(invite.createdAt, language)} ·{" "}
              {say("到期", "Expires")} {new Date(invite.expiresAt).toLocaleDateString(language)}
            </span>
          </div>
          <div className="adminAccountRoleActions">
            <button
              type="button"
              disabled={busy}
              onClick={() => void copy(invite.code).then(() => setMessage(say("已复制。", "Copied.")))}
            >
              {say("复制链接", "Copy link")}
            </button>
            <button
              type="button"
              className={`danger adminDanger ${armed === invite.code ? "armed" : ""}`}
              disabled={busy}
              onClick={() => void revoke(invite.code)}
            >
              {armed === invite.code ? say("确认撤销", "Confirm revoke") : say("撤销", "Revoke")}
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}
