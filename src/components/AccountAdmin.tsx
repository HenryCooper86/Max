// Admin-only account management: the registered users, tester removal, and
// single-use invite links for onboarding while self-registration stays closed.

import { useCallback, useEffect, useState } from "react";
import {
  createInviteLink,
  deleteUserAccount,
  fetchAdminOverview,
  inviteUrl,
  revokeInviteLink,
  type AdminOverview
} from "../lib/auth";
import { formatRelativeTime } from "../lib/utils";

export function AccountAdmin({ adminUsername }: { adminUsername: string }) {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [createdCopied, setCreatedCopied] = useState(false);
  // Two-step confirm for tester removal, same pattern as the clear buttons.
  const [armedDelete, setArmedDelete] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setOverview(await fetchAdminOverview());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!armedDelete) return;
    const timer = window.setTimeout(() => setArmedDelete(null), 4000);
    return () => window.clearTimeout(timer);
  }, [armedDelete]);

  const makeInvite = async () => {
    setBusy(true);
    setNotice(null);
    const invite = await createInviteLink();
    if (invite) {
      // The link lands on the clipboard immediately — paste it to the tester.
      await navigator.clipboard?.writeText(inviteUrl(invite.code)).catch(() => {});
      setCreatedCopied(true);
      window.setTimeout(() => setCreatedCopied(false), 3000);
      await refresh();
    } else {
      setNotice("生成邀请失败 — 请确认仍以管理员登录。");
    }
    setBusy(false);
  };

  const copyInvite = async (code: string) => {
    await navigator.clipboard?.writeText(inviteUrl(code)).catch(() => {});
    setCopiedCode(code);
    window.setTimeout(() => setCopiedCode(null), 2000);
  };

  const removeInvite = async (code: string) => {
    setBusy(true);
    await revokeInviteLink(code);
    await refresh();
    setBusy(false);
  };

  const removeUser = async (username: string) => {
    if (armedDelete !== username) {
      setArmedDelete(username);
      return;
    }
    setArmedDelete(null);
    setBusy(true);
    setNotice(null);
    const result = await deleteUserAccount(username);
    if (!result.ok) setNotice(result.error ?? "删除失败。");
    await refresh();
    setBusy(false);
  };

  const users = overview?.users ?? [];
  const invites = overview?.invites ?? [];

  return (
    <div className="accountAdmin" aria-label="账号管理">
      <div className="accountAdminHead">
        <div>
          <span>账号管理</span>
          <strong>
            {users.length} 个账号 · {invites.length} 个未使用邀请
          </strong>
        </div>
        <button type="button" disabled={busy} onClick={() => void makeInvite()}>
          {createdCopied ? "邀请链接已复制 ✓" : "生成邀请链接"}
        </button>
      </div>

      {notice ? (
        <p className="adminNotice" role="alert">
          {notice}
        </p>
      ) : null}

      <div className="accountAdminList">
        {users.map((user) => (
          <div className="accountAdminRow" key={user.id}>
            <div className="accountAdminUser">
              <strong>{user.displayName}</strong>
              <span>
                @{user.username} · {user.role === "admin" ? "管理员" : "测试员"} · 最近登录{" "}
                {formatRelativeTime(user.lastLoginAt)}
              </span>
            </div>
            {user.role === "admin" ? (
              <span className="accountAdminSelf">{user.username === adminUsername ? "当前账号" : "管理员"}</span>
            ) : (
              <button
                type="button"
                className={`danger ${armedDelete === user.username ? "armed" : ""}`}
                disabled={busy}
                onClick={() => void removeUser(user.username)}
              >
                {armedDelete === user.username ? "确认删除?" : "删除"}
              </button>
            )}
          </div>
        ))}
        {invites.map((invite) => (
          <div className="accountAdminRow invite" key={invite.code}>
            <div className="accountAdminUser">
              <strong>邀请 · {invite.code.slice(4, 12)}…</strong>
              <span>
                由 {invite.createdBy} 创建 · {formatRelativeTime(invite.createdAt)} · 7 天内单次有效
              </span>
            </div>
            <div className="accountAdminInviteActions">
              <button type="button" onClick={() => void copyInvite(invite.code)}>
                {copiedCode === invite.code ? "已复制 ✓" : "复制链接"}
              </button>
              <button type="button" className="danger" disabled={busy} onClick={() => void removeInvite(invite.code)}>
                撤销
              </button>
            </div>
          </div>
        ))}
        {!users.length && !invites.length ? <p className="testerConversationEmpty">正在加载账号数据…</p> : null}
      </div>
    </div>
  );
}
