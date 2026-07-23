import { useCallback, useEffect, useRef, useState } from "react";
import { adminAccountApi, inviteUrl, type AdminOverview, type AuthUser } from "../../lib/auth";
import { useLanguage } from "../LanguageToggle";
import { adminRoleLabel, confirmationCopy, formatAdminRelativeTime } from "./admin-model";

const INVITE_EXPIRING_SOON_MS = 2 * 24 * 60 * 60 * 1000;

type LoadStatus = "loading" | "ready" | "stale";
type Notice = { tone: "success" | "error"; message: string };

function formatInviteExpiry(timestamp: number) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "—";
  const remainingMs = timestamp - Date.now();
  if (remainingMs <= 0) return "已过期";
  if (remainingMs < 3_600_000) return `${Math.ceil(remainingMs / 60_000)} 分钟后`;
  if (remainingMs < 86_400_000) return `${Math.ceil(remainingMs / 3_600_000)} 小时后`;
  return `${Math.ceil(remainingMs / 86_400_000)} 天后`;
}

async function writeClipboard(value: string): Promise<boolean> {
  if (!navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

export function AccountManagement({
  user,
  onAuthenticationExpired
}: {
  user: AuthUser;
  onAuthenticationExpired: () => void;
}) {
  const { language } = useLanguage();
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [loadNotice, setLoadNotice] = useState<Notice | null>(null);
  const [actionNotice, setActionNotice] = useState<Notice | null>(null);
  const [busyTarget, setBusyTarget] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [createdCopied, setCreatedCopied] = useState(false);
  const [manualInviteUrl, setManualInviteUrl] = useState<string | null>(null);
  const [accountFilter, setAccountFilter] = useState("");
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  const [armedInvite, setArmedInvite] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const accountOwnerRef = useRef(user.id);
  const loadSequenceRef = useRef(0);
  const mutationSequenceRef = useRef(0);
  const clipboardSequenceRef = useRef(0);
  const authenticationExpiredRef = useRef(onAuthenticationExpired);
  authenticationExpiredRef.current = onAuthenticationExpired;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadSequenceRef.current += 1;
      mutationSequenceRef.current += 1;
      clipboardSequenceRef.current += 1;
    };
  }, []);

  const ownsAccount = useCallback((ownerId: string) => mountedRef.current && accountOwnerRef.current === ownerId, []);

  const refresh = useCallback(
    async (ownerId: string): Promise<boolean> => {
      const sequence = ++loadSequenceRef.current;
      const result = await adminAccountApi.fetchOverview();
      if (!ownsAccount(ownerId) || sequence !== loadSequenceRef.current) return false;
      if (result.ok) {
        setOverview(result.data);
        setStatus("ready");
        setLoadNotice(null);
        return true;
      }
      setStatus("stale");
      if (result.error.kind === "unauthorized") {
        authenticationExpiredRef.current();
      } else {
        setLoadNotice({ tone: "error", message: result.error.message });
      }
      return false;
    },
    [ownsAccount]
  );

  useEffect(() => {
    const ownerId = user.id;
    accountOwnerRef.current = ownerId;
    loadSequenceRef.current += 1;
    mutationSequenceRef.current += 1;
    clipboardSequenceRef.current += 1;
    setOverview(null);
    setStatus("loading");
    setLoadNotice(null);
    setActionNotice(null);
    setBusyTarget(null);
    setCopiedCode(null);
    setCreatedCopied(false);
    setManualInviteUrl(null);
    setArmedDelete(null);
    setArmedInvite(null);
    void refresh(ownerId);
    const timer = window.setInterval(() => void refresh(ownerId), 30_000);
    return () => {
      window.clearInterval(timer);
      loadSequenceRef.current += 1;
      mutationSequenceRef.current += 1;
      clipboardSequenceRef.current += 1;
    };
  }, [refresh, user.id]);

  useEffect(() => {
    if (!armedDelete) return;
    const timer = window.setTimeout(() => setArmedDelete(null), 4000);
    return () => window.clearTimeout(timer);
  }, [armedDelete]);

  useEffect(() => {
    if (!armedInvite) return;
    const timer = window.setTimeout(() => setArmedInvite(null), 4000);
    return () => window.clearTimeout(timer);
  }, [armedInvite]);

  useEffect(() => {
    if (!copiedCode) return;
    const timer = window.setTimeout(() => setCopiedCode(null), 2000);
    return () => window.clearTimeout(timer);
  }, [copiedCode]);

  useEffect(() => {
    if (!createdCopied) return;
    const timer = window.setTimeout(() => setCreatedCopied(false), 3000);
    return () => window.clearTimeout(timer);
  }, [createdCopied]);

  const beginMutation = (target: string) => {
    const ownerId = accountOwnerRef.current;
    const sequence = ++mutationSequenceRef.current;
    clipboardSequenceRef.current += 1;
    setBusyTarget(target);
    setActionNotice(null);
    setManualInviteUrl(null);
    return {
      ownerId,
      sequence,
      owns: () => ownsAccount(ownerId) && mutationSequenceRef.current === sequence
    };
  };

  const finishMutation = (operation: ReturnType<typeof beginMutation>) => {
    if (operation.owns()) setBusyTarget(null);
  };

  const refreshAfterMutation = async (operation: ReturnType<typeof beginMutation>): Promise<boolean> => {
    const refreshed = await refresh(operation.ownerId);
    return operation.owns() && refreshed;
  };

  const failMutation = (operation: ReturnType<typeof beginMutation>, error: { kind: string; message: string }) => {
    if (!operation.owns()) return;
    if (error.kind === "unauthorized") authenticationExpiredRef.current();
    else setActionNotice({ tone: "error", message: error.message });
  };

  const makeInvite = async () => {
    const operation = beginMutation("create-invite");
    const result = await adminAccountApi.createInvite();
    if (!operation.owns()) return;
    if (!result.ok) {
      failMutation(operation, result.error);
      finishMutation(operation);
      return;
    }
    const createdUrl = inviteUrl(result.data.code);
    const copied = await writeClipboard(createdUrl);
    if (!operation.owns()) return;
    setCreatedCopied(copied);
    setManualInviteUrl(copied ? null : createdUrl);
    setActionNotice(
      copied
        ? { tone: "success", message: "邀请链接已生成并复制。" }
        : { tone: "error", message: "链接已生成，但无法写入剪贴板。" }
    );
    await refreshAfterMutation(operation);
    if (!operation.owns()) return;
    finishMutation(operation);
  };

  const copyInvite = async (code: string) => {
    if (busyTarget !== null) return;
    const ownerId = accountOwnerRef.current;
    const sequence = ++clipboardSequenceRef.current;
    const url = inviteUrl(code);
    const copied = await writeClipboard(url);
    if (!ownsAccount(ownerId) || clipboardSequenceRef.current !== sequence) {
      return;
    }
    if (copied) {
      setCopiedCode(code);
      setManualInviteUrl(null);
      setActionNotice(null);
    } else {
      setCopiedCode(null);
      setManualInviteUrl(url);
      setActionNotice({ tone: "error", message: "无法写入剪贴板，请手动复制邀请链接。" });
    }
  };

  const removeInvite = async (code: string) => {
    if (armedInvite !== code) {
      setArmedDelete(null);
      setArmedInvite(code);
      return;
    }
    setArmedInvite(null);
    const operation = beginMutation(`invite:${code}`);
    const result = await adminAccountApi.revokeInvite(code);
    if (!operation.owns()) return;
    if (!result.ok) {
      failMutation(operation, result.error);
      finishMutation(operation);
      return;
    }
    setActionNotice(
      result.data.removed
        ? { tone: "success", message: "邀请已撤销。" }
        : { tone: "success", message: "邀请已不存在，无需再次撤销。" }
    );
    await refreshAfterMutation(operation);
    if (!operation.owns()) return;
    finishMutation(operation);
  };

  const removeUser = async (username: string) => {
    if (armedDelete !== username) {
      setArmedInvite(null);
      setArmedDelete(username);
      return;
    }
    setArmedDelete(null);
    const operation = beginMutation(`user:${username}`);
    const result = await adminAccountApi.deleteUser(username);
    if (!operation.owns()) return;
    if (!result.ok) {
      failMutation(operation, result.error);
      finishMutation(operation);
      return;
    }
    if (result.data.username !== username) {
      setActionNotice({ tone: "error", message: "服务器返回的账号与删除目标不一致。" });
      finishMutation(operation);
      return;
    }
    setActionNotice({ tone: "success", message: `@${username} 已删除。` });
    await refreshAfterMutation(operation);
    if (!operation.owns()) return;
    finishMutation(operation);
  };

  const changeRole = async (username: string, role: AuthUser["role"]) => {
    const operation = beginMutation(`role:${username}`);
    const result = await adminAccountApi.updateRole(username, role);
    if (!operation.owns()) return;
    if (!result.ok) {
      failMutation(operation, result.error);
      finishMutation(operation);
      return;
    }
    if (result.data.username !== username || result.data.role !== role) {
      setActionNotice({ tone: "error", message: "服务器返回的角色更新与请求目标不一致。" });
      finishMutation(operation);
      return;
    }
    setActionNotice({
      tone: "success",
      message:
        language === "en-US"
          ? `@${username} is now ${adminRoleLabel(role, language)}.`
          : `@${username} 现在是${adminRoleLabel(role, language)}。`
    });
    await refreshAfterMutation(operation);
    if (!operation.owns()) return;
    finishMutation(operation);
  };

  const users = [...(overview?.users ?? [])].sort(
    (a, b) =>
      Number(b.username === user.username) - Number(a.username === user.username) ||
      Number(b.role === "admin") - Number(a.role === "admin") ||
      Number(b.role === "reviewer") - Number(a.role === "reviewer") ||
      b.lastLoginAt - a.lastLoginAt
  );
  const invites = [...(overview?.invites ?? [])].sort((a, b) => a.expiresAt - b.expiresAt);
  const normalizedFilter = accountFilter.trim().toLowerCase();
  const filteredUsers = users.filter((account) => {
    if (!normalizedFilter) return true;
    return `${account.displayName} ${account.username} ${account.role}`.toLowerCase().includes(normalizedFilter);
  });
  const filteredInvites = invites.filter((item) => {
    if (!normalizedFilter) return true;
    return `${item.code} ${item.createdBy}`.toLowerCase().includes(normalizedFilter);
  });
  const expiringInviteCount = invites.filter((item) => {
    const remainingMs = item.expiresAt - Date.now();
    return remainingMs > 0 && remainingMs <= INVITE_EXPIRING_SOON_MS;
  }).length;

  return (
    <div className="adminAccount adminSectionCard" aria-label="账号管理" data-load-status={status}>
      <div className="adminAccountHead adminSectionHeader">
        <div>
          <span>账号管理</span>
          <strong>
            {users.length} 个账号 · {invites.length} 个未使用邀请
          </strong>
        </div>
        <button type="button" disabled={busyTarget !== null} onClick={() => void makeInvite()}>
          {busyTarget === "create-invite" ? "正在生成…" : createdCopied ? "邀请链接已复制 ✓" : "生成邀请链接"}
        </button>
      </div>

      <div className="adminAccountSummary" aria-label="账号概览">
        <span>
          <b>{users.filter((account) => account.role === "admin").length}</b>
          管理员
        </span>
        <span>
          <b>{users.filter((account) => account.role === "reviewer").length}</b>
          审核员
        </span>
        <span>
          <b>{users.filter((account) => account.role === "tester").length}</b>
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

      <label className="adminAccountFilter">
        <span>查找账号或邀请</span>
        <input
          value={accountFilter}
          onChange={(event) => setAccountFilter(event.target.value)}
          placeholder="姓名、角色或邀请码"
          autoComplete="off"
          spellCheck={false}
        />
      </label>

      {status === "stale" ? (
        <p className="adminNotice" role="status">
          数据可能已过期
        </p>
      ) : null}
      {loadNotice ? (
        <p className={`adminNotice ${loadNotice.tone}`} role={loadNotice.tone === "error" ? "alert" : "status"}>
          {loadNotice.message}
        </p>
      ) : null}
      {actionNotice ? (
        <p className={`adminNotice ${actionNotice.tone}`} role={actionNotice.tone === "error" ? "alert" : "status"}>
          {actionNotice.message}
        </p>
      ) : null}
      {manualInviteUrl ? (
        <label className="adminAccountFilter accountInviteRecovery">
          <span>手动复制邀请链接</span>
          <input
            aria-label="手动复制邀请链接"
            value={manualInviteUrl}
            readOnly
            onFocus={(event) => event.currentTarget.select()}
          />
        </label>
      ) : null}

      <div className="adminAccountList">
        {filteredUsers.map((account) => (
          <div className="accountAdminRow" key={account.id}>
            <div className="adminAccountUser">
              <strong>{account.displayName}</strong>
              <span>
                @{account.username} · {adminRoleLabel(account.role, language)} ·{" "}
                {language === "en-US" ? "Last login " : "最近登录 "} {formatAdminRelativeTime(account.lastLoginAt)}
              </span>
            </div>
            <div className="adminAccountRoleActions">
              {account.username === user.username ? (
                <span className="adminAccountSelf">
                  {language === "en-US" ? "Current account" : "当前账号"} · {adminRoleLabel(account.role, language)}
                </span>
              ) : (
                <>
                  <select
                    value={account.role}
                    aria-label={`${account.username} 的角色`}
                    disabled={busyTarget !== null}
                    onChange={(event) => void changeRole(account.username, event.target.value as AuthUser["role"])}
                  >
                    <option value="tester">测试员</option>
                    <option value="reviewer">审核员</option>
                    <option value="admin">管理员</option>
                  </select>
                  {account.role !== "admin" ? (
                    <button
                      type="button"
                      className={`danger adminDanger ${armedDelete === account.username ? "armed" : ""}`}
                      disabled={busyTarget !== null}
                      onClick={() => void removeUser(account.username)}
                    >
                      {armedDelete === account.username ? confirmationCopy("user", `@${account.username}`) : "删除"}
                    </button>
                  ) : null}
                </>
              )}
            </div>
          </div>
        ))}
        {filteredInvites.map((item) => (
          <div className="accountAdminRow invite" key={item.code}>
            <div className="adminAccountUser">
              <strong>邀请 · {item.code.slice(4, 12)}…</strong>
              <span>
                由 {item.createdBy} 创建 · {formatAdminRelativeTime(item.createdAt)} · 过期{" "}
                {formatInviteExpiry(item.expiresAt)}
              </span>
            </div>
            <div className="adminAccountInviteActions">
              <button type="button" disabled={busyTarget !== null} onClick={() => void copyInvite(item.code)}>
                {copiedCode === item.code ? "已复制 ✓" : "复制链接"}
              </button>
              <button
                type="button"
                className={`danger adminDanger ${armedInvite === item.code ? "armed" : ""}`}
                disabled={busyTarget !== null}
                onClick={() => void removeInvite(item.code)}
              >
                {busyTarget === `invite:${item.code}`
                  ? "正在撤销…"
                  : armedInvite === item.code
                    ? confirmationCopy("invite", item.code)
                    : "撤销"}
              </button>
            </div>
          </div>
        ))}
        {!filteredUsers.length && !filteredInvites.length ? (
          <p className="testerConversationEmpty">
            {status === "loading"
              ? "正在加载账号数据…"
              : users.length || invites.length
                ? "没有账号或邀请匹配当前筛选。"
                : status === "stale"
                  ? "暂时无法加载账号数据。"
                  : "暂无账号或未使用邀请。"}
          </p>
        ) : null}
      </div>
    </div>
  );
}
