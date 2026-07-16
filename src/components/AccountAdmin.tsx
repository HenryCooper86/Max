// Admin-only account management: the registered users, tester removal, and
// single-use invite links for onboarding while self-registration stays closed.

import { useCallback, useEffect, useState } from "react";
import {
  createInviteLink,
  deleteUserAccount,
  fetchAdminOverview,
  inviteUrl,
  revokeInviteLink,
  updateUserRole,
  type AdminOverview
} from "../lib/auth";
import { formatRelativeTime } from "../lib/utils";

const INVITE_EXPIRING_SOON_MS = 2 * 24 * 60 * 60 * 1000;

function formatInviteExpiry(timestamp: number) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "—";
  const remainingMs = timestamp - Date.now();
  if (remainingMs <= 0) return "已过期";
  if (remainingMs < 3_600_000) return `${Math.ceil(remainingMs / 60_000)} 分钟后`;
  if (remainingMs < 86_400_000) return `${Math.ceil(remainingMs / 3_600_000)} 小时后`;
  return `${Math.ceil(remainingMs / 86_400_000)} 天后`;
}

export function AccountAdmin({ adminUsername }: { adminUsername: string }) {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [createdCopied, setCreatedCopied] = useState(false);
  const [accountFilter, setAccountFilter] = useState("");
  // Two-step confirm for tester removal, same pattern as the clear buttons.
  const [armedDelete, setArmedDelete] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const next = await fetchAdminOverview();
    setOverview(next);
    setLoadFailed(next === null);
  }, []);

  // Refresh on mount and keep it current: invites get consumed by testers
  // registering, and sessions expire — a fetch-once list goes stale silently.
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(timer);
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

  const changeRole = async (username: string, role: "admin" | "reviewer" | "tester") => {
    setBusy(true);
    setNotice(null);
    const result = await updateUserRole(username, role);
    setNotice(result.ok ? `@${username} 现在是 ${role}。` : (result.error ?? "角色更新失败。"));
    await refresh();
    setBusy(false);
  };

  const users = [...(overview?.users ?? [])].sort(
    (a, b) =>
      Number(b.username === adminUsername) - Number(a.username === adminUsername) ||
      Number(b.role === "admin") - Number(a.role === "admin") ||
      Number(b.role === "reviewer") - Number(a.role === "reviewer") ||
      b.lastLoginAt - a.lastLoginAt
  );
  const invites = [...(overview?.invites ?? [])].sort((a, b) => a.expiresAt - b.expiresAt);
  const normalizedFilter = accountFilter.trim().toLowerCase();
  const filteredUsers = users.filter((user) => {
    if (!normalizedFilter) return true;
    return `${user.displayName} ${user.username} ${user.role}`.toLowerCase().includes(normalizedFilter);
  });
  const filteredInvites = invites.filter((invite) => {
    if (!normalizedFilter) return true;
    return `${invite.code} ${invite.createdBy}`.toLowerCase().includes(normalizedFilter);
  });
  const adminCount = users.filter((user) => user.role === "admin").length;
  const reviewerCount = users.filter((user) => user.role === "reviewer").length;
  const testerCount = users.filter((user) => user.role === "tester").length;
  const expiringInviteCount = invites.filter((invite) => {
    const remainingMs = invite.expiresAt - Date.now();
    // "Expiring soon" excludes already-expired invites (remainingMs <= 0), which
    // formatInviteExpiry renders separately as 已过期.
    return remainingMs > 0 && remainingMs <= INVITE_EXPIRING_SOON_MS;
  }).length;

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

      <div className="accountAdminSummary" aria-label="账号概览">
        <span>
          <b>{adminCount}</b>
          管理员
        </span>
        <span>
          <b>{reviewerCount}</b>
          审核员
        </span>
        <span>
          <b>{testerCount}</b>
          测试员
        </span>
        <span>
          <b>{invites.length}</b>
          未使用邀请
        </span>
        <span className={expiringInviteCount ? "warn" : ""}>
          <b>{expiringInviteCount}</b>
          即将过期
        </span>
      </div>

      <label className="accountAdminFilter">
        <span>Find account or invite</span>
        <input
          value={accountFilter}
          onChange={(event) => setAccountFilter(event.target.value)}
          placeholder="name, role, invite code"
          autoComplete="off"
          spellCheck={false}
        />
      </label>

      {notice ? (
        <p className="adminNotice" role="alert">
          {notice}
        </p>
      ) : null}

      <div className="accountAdminList">
        {filteredUsers.map((user) => (
          <div className="accountAdminRow" key={user.id}>
            <div className="accountAdminUser">
              <strong>{user.displayName}</strong>
              <span>
                @{user.username} · {user.role === "admin" ? "管理员" : user.role === "reviewer" ? "审核员" : "测试员"} ·
                最近登录 {formatRelativeTime(user.lastLoginAt)}
              </span>
            </div>
            <div className="accountAdminRoleActions">
              <select
                value={user.role}
                aria-label={`Role for ${user.username}`}
                disabled={busy}
                onChange={(event) =>
                  void changeRole(user.username, event.target.value as "admin" | "reviewer" | "tester")
                }
              >
                <option value="tester">Tester</option>
                <option value="reviewer">Reviewer</option>
                <option value="admin">Admin</option>
              </select>
              {user.username === adminUsername ? (
                <span className="accountAdminSelf">当前账号</span>
              ) : user.role !== "admin" ? (
                <button
                  type="button"
                  className={`danger ${armedDelete === user.username ? "armed" : ""}`}
                  disabled={busy}
                  onClick={() => void removeUser(user.username)}
                >
                  {armedDelete === user.username ? "确认删除?" : "删除"}
                </button>
              ) : null}
            </div>
          </div>
        ))}
        {filteredInvites.map((invite) => (
          <div className="accountAdminRow invite" key={invite.code}>
            <div className="accountAdminUser">
              <strong>邀请 · {invite.code.slice(4, 12)}…</strong>
              <span>
                由 {invite.createdBy} 创建 · {formatRelativeTime(invite.createdAt)} · 过期{" "}
                {formatInviteExpiry(invite.expiresAt)}
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
        {!filteredUsers.length && !filteredInvites.length ? (
          <p className="testerConversationEmpty">
            {loadFailed
              ? "无法加载账号数据 — 会话可能已过期，请重新登录。"
              : users.length || invites.length
                ? "没有账号或邀请匹配当前筛选。"
                : "正在加载账号数据…"}
          </p>
        ) : null}
      </div>
    </div>
  );
}
