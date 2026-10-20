import { useCallback, useEffect, useRef, useState } from "react";
import { adminAccountApi, inviteUrl, type AdminOverview, type AuthUser } from "../../lib/auth";
import { useLanguage } from "../LanguageToggle";
import { localized, type Language } from "../../lib/i18n";
import { adminRoleLabel, confirmationCopy, formatAdminRelativeTime } from "./admin-model";
import { readAdminLocation, setAdminLocation, useAdminLocation } from "./admin-location";

const INVITE_EXPIRING_SOON_MS = 2 * 24 * 60 * 60 * 1000;

type LoadStatus = "loading" | "ready" | "stale";
type Notice = { tone: "success" | "error"; message: string };
type AccountMutation = { ownerId: string; sequence: number; owns: () => boolean };

/** Absolute expiry plus a readable countdown, so an admin never has to do
 * date math before deciding whether an invite needs a nudge. */
function formatInviteExpiry(timestamp: number, language: Language) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "—";
  const absolute = new Intl.DateTimeFormat(language === "en-US" ? "en-US" : "zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(timestamp);
  const remainingMs = timestamp - Date.now();
  if (remainingMs <= 0) {
    return language === "en-US" ? `expired ${absolute}` : `已于 ${absolute} 过期`;
  }
  const unit =
    remainingMs < 3_600_000
      ? { count: Math.ceil(remainingMs / 60_000), zh: "分钟", en: "min" }
      : remainingMs < 86_400_000
        ? { count: Math.ceil(remainingMs / 3_600_000), zh: "小时", en: "hr" }
        : { count: Math.ceil(remainingMs / 86_400_000), zh: "天", en: "day" };
  return language === "en-US"
    ? `${absolute} (in ${unit.count} ${unit.en})`
    : `${absolute}（${unit.count} ${unit.zh}后过期）`;
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

const ROLE_DETAILS: Record<AuthUser["role"], readonly [string, string]> = {
  admin: ["管理账号与邀请、发布策略、批准版本", "Manage accounts and invites, publish policy, approve builds"],
  reviewer: ["复核证据、处理评审、管理发布验证", "Review evidence, triage findings, manage release runs"],
  tester: ["记录并提交测试会话证据", "Record and submit testing sessions"]
};

export function AccountManagement({
  user,
  onAuthenticationExpired
}: {
  user: AuthUser;
  onAuthenticationExpired: () => void;
}) {
  const { language } = useLanguage();
  const location = useAdminLocation();
  const onAccountsSection = location.isAdmin && location.section === "accounts";
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [loadNotice, setLoadNotice] = useState<Notice | null>(null);
  const [actionNotice, setActionNotice] = useState<Notice | null>(null);
  const [busyTarget, setBusyTarget] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [createdCopied, setCreatedCopied] = useState(false);
  const [manualInviteUrl, setManualInviteUrl] = useState<string | null>(null);
  const [accountFilter, setAccountFilter] = useState<string>(() => {
    const initial = readAdminLocation();
    return initial.isAdmin && initial.section === "accounts" ? (initial.params.get("q") ?? "") : "";
  });
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

  // URL is the source of truth while the accounts section is visible; the
  // component stays mounted when hidden, so hydration ignores other sections.
  const accountQuery = onAccountsSection ? (location.params.get("q") ?? "") : null;
  useEffect(() => {
    if (accountQuery === null) return;
    setAccountFilter((current) => (current === accountQuery ? current : accountQuery));
  }, [accountQuery]);

  const updateAccountFilter = (value: string) => {
    setAccountFilter(value);
    // Hidden sections must never rewrite the visible route.
    if (!(location.isAdmin && location.section === "accounts")) return;
    setAdminLocation("accounts", { q: value === "" ? null : value });
  };

  const beginMutation = (target: string): AccountMutation => {
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

  const finishMutation = (operation: AccountMutation) => {
    if (operation.owns()) setBusyTarget(null);
  };

  const refreshAfterMutation = async (operation: AccountMutation): Promise<boolean> => {
    const refreshed = await refresh(operation.ownerId);
    return operation.owns() && refreshed;
  };

  const failMutation = (operation: AccountMutation, error: { kind: string; message: string }) => {
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
        ? {
            tone: "success",
            message: localized(language, "邀请链接已生成并复制。", "Invite link generated and copied.")
          }
        : {
            tone: "error",
            message: localized(
              language,
              "链接已生成，但无法写入剪贴板。",
              "Link generated, but the clipboard is unavailable."
            )
          }
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
      setActionNotice({
        tone: "error",
        message: localized(
          language,
          "无法写入剪贴板，请手动复制邀请链接。",
          "Could not write to clipboard; copy the invite link manually."
        )
      });
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
        ? { tone: "success", message: localized(language, "邀请已撤销。", "Invite revoked.") }
        : {
            tone: "success",
            message: localized(language, "邀请已不存在，无需再次撤销。", "Invite already gone; nothing to revoke.")
          }
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
      setActionNotice({
        tone: "error",
        message: localized(
          language,
          "服务器返回的账号与删除目标不一致。",
          "The server returned a different account than the delete target."
        )
      });
      finishMutation(operation);
      return;
    }
    setActionNotice({
      tone: "success",
      message: localized(language, `@${username} 已删除。`, `@${username} deleted.`)
    });
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
      setActionNotice({
        tone: "error",
        message: localized(
          language,
          "服务器返回的角色更新与请求目标不一致。",
          "The server returned a different role update than requested."
        )
      });
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
    <div
      className="adminAccount adminSectionCard"
      aria-label={localized(language, "账号管理", "Account management")}
      data-load-status={status}
    >
      <div className="adminAccountHead adminSectionHeader">
        <div>
          <span>{localized(language, "账号管理", "Account management")}</span>
          <strong>
            {users.length} {localized(language, "个账号", "accounts")} · {invites.length}{" "}
            {localized(language, "个未使用邀请", "unused invites")}
          </strong>
        </div>
        <button type="button" disabled={busyTarget !== null} onClick={() => void makeInvite()}>
          {busyTarget === "create-invite"
            ? localized(language, "正在生成…", "Generating…")
            : createdCopied
              ? localized(language, "邀请链接已复制 ✓", "Invite link copied ✓")
              : localized(language, "生成邀请链接", "Generate invite link")}
        </button>
      </div>

      <div className="adminAccountSummary" aria-label={localized(language, "账号概览", "Account overview")}>
        <span>
          <b>{users.filter((account) => account.role === "admin").length}</b>
          {localized(language, "管理员", "Administrators")}
        </span>
        <span>
          <b>{users.filter((account) => account.role === "reviewer").length}</b>
          {localized(language, "审核员", "Reviewers")}
        </span>
        <span>
          <b>{users.filter((account) => account.role === "tester").length}</b>
          {localized(language, "测试员", "Testers")}
        </span>
        <span>
          <b>{invites.length}</b>
          {localized(language, "未使用邀请", "Unused invites")}
        </span>
        <span className={expiringInviteCount ? "warn" : ""}>
          <b>{expiringInviteCount}</b>
          {localized(language, "即将过期", "Expiring soon")}
        </span>
      </div>

      <details className="accountPermissions">
        <summary>{localized(language, "角色权限说明", "Role permissions")}</summary>
        <dl className="accountRoleLegend" aria-label={localized(language, "角色权限说明", "Role permissions")}>
          {(["admin", "reviewer", "tester"] as const).map((role) => (
            <div key={role}>
              <dt>{adminRoleLabel(role, language)}</dt>
              <dd>{localized(language, ROLE_DETAILS[role][0], ROLE_DETAILS[role][1])}</dd>
            </div>
          ))}
        </dl>
      </details>

      <label className="adminAccountFilter">
        <span>{localized(language, "查找账号或邀请", "Find account or invite")}</span>
        <input
          value={accountFilter}
          onChange={(event) => updateAccountFilter(event.target.value)}
          placeholder={localized(language, "姓名、角色或邀请码", "Name, role, or invite code")}
          autoComplete="off"
          spellCheck={false}
        />
      </label>

      {status === "stale" ? (
        <p className="adminNotice" role="status">
          {localized(language, "数据可能已过期", "Data may be stale")}
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
          <span>{localized(language, "手动复制邀请链接", "Copy invite link manually")}</span>
          <input
            aria-label={localized(language, "手动复制邀请链接", "Copy invite link manually")}
            value={manualInviteUrl}
            readOnly
            onFocus={(event) => event.currentTarget.select()}
          />
        </label>
      ) : null}

      <div className="adminAccountList">
        <section className="adminAccountGroup" aria-label={localized(language, "用户", "Users")}>
          <h4 className="adminAccountGroupHead">
            {localized(language, "用户", "Users")}
            <span>
              {filteredUsers.length} / {users.length}
            </span>
          </h4>
          {filteredUsers.map((account) => (
            <div className="accountAdminRow" key={account.id}>
              <div className="adminAccountUser">
                <strong>{account.displayName}</strong>
                <span>
                  @{account.username} · {adminRoleLabel(account.role, language)} ·{" "}
                  {language === "en-US" ? "Last login " : "最近登录 "}{" "}
                  {formatAdminRelativeTime(account.lastLoginAt, language)}
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
                      aria-label={localized(language, `${account.username} 的角色`, `${account.username}'s role`)}
                      disabled={busyTarget !== null}
                      onChange={(event) => void changeRole(account.username, event.target.value as AuthUser["role"])}
                    >
                      <option value="tester">{localized(language, "测试员", "Tester")}</option>
                      <option value="reviewer">{localized(language, "审核员", "Reviewer")}</option>
                      <option value="admin">{localized(language, "管理员", "Administrator")}</option>
                    </select>
                    {account.role !== "admin" ? (
                      <button
                        type="button"
                        className={`danger adminDanger ${armedDelete === account.username ? "armed" : ""}`}
                        disabled={busyTarget !== null}
                        onClick={() => void removeUser(account.username)}
                      >
                        {armedDelete === account.username
                          ? confirmationCopy("user", `@${account.username}`, language)
                          : localized(language, "删除", "Delete")}
                      </button>
                    ) : null}
                  </>
                )}
              </div>
            </div>
          ))}
          {!filteredUsers.length && users.length ? (
            <p className="testerConversationEmpty">
              {localized(language, "没有账号匹配当前筛选。", "No accounts match this filter.")}
            </p>
          ) : null}
        </section>

        <section className="adminAccountGroup" aria-label={localized(language, "未使用邀请", "Unused invites")}>
          <h4 className="adminAccountGroupHead">
            {localized(language, "未使用邀请", "Unused invites")}
            <span className={expiringInviteCount ? "warn" : ""}>
              {filteredInvites.length} / {invites.length}
              {expiringInviteCount
                ? localized(language, ` · ${expiringInviteCount} 即将过期`, ` · ${expiringInviteCount} expiring soon`)
                : ""}
            </span>
          </h4>
          {filteredInvites.map((item) => {
            const remainingMs = item.expiresAt - Date.now();
            const expired = remainingMs <= 0;
            const expiringSoon = !expired && remainingMs <= INVITE_EXPIRING_SOON_MS;
            return (
              <div className="accountAdminRow invite" key={item.code}>
                <div className="adminAccountUser">
                  <strong>
                    {localized(language, "邀请", "Invite")} · {item.code.slice(4, 12)}…
                    <span className={`inviteStatus${expired ? " expired" : expiringSoon ? " warn" : ""}`}>
                      {expired
                        ? localized(language, "已过期", "Expired")
                        : expiringSoon
                          ? localized(language, "即将过期", "Expiring soon")
                          : localized(language, "未使用", "Unused")}
                    </span>
                  </strong>
                  <span>
                    {localized(language, "由", "Created by")} {item.createdBy} {localized(language, "创建", "created")}{" "}
                    · {formatAdminRelativeTime(item.createdAt, language)} · {localized(language, "过期", "Expires")}{" "}
                    {formatInviteExpiry(item.expiresAt, language)}
                  </span>
                </div>
                <div className="adminAccountInviteActions">
                  <button type="button" disabled={busyTarget !== null} onClick={() => void copyInvite(item.code)}>
                    {copiedCode === item.code
                      ? localized(language, "已复制 ✓", "Copied ✓")
                      : localized(language, "复制链接", "Copy link")}
                  </button>
                  <button
                    type="button"
                    className={`danger adminDanger ${armedInvite === item.code ? "armed" : ""}`}
                    disabled={busyTarget !== null}
                    onClick={() => void removeInvite(item.code)}
                  >
                    {busyTarget === `invite:${item.code}`
                      ? localized(language, "正在撤销…", "Revoking…")
                      : armedInvite === item.code
                        ? confirmationCopy("invite", item.code, language)
                        : localized(language, "撤销", "Revoke")}
                  </button>
                </div>
              </div>
            );
          })}
          {!filteredInvites.length && invites.length ? (
            <p className="testerConversationEmpty">
              {localized(language, "没有邀请匹配当前筛选。", "No invites match this filter.")}
            </p>
          ) : null}
        </section>

        {!users.length && !invites.length ? (
          <p className="testerConversationEmpty">
            {status === "loading"
              ? localized(language, "正在加载账号数据…", "Loading account data…")
              : status === "stale"
                ? localized(language, "暂时无法加载账号数据。", "Account data is temporarily unavailable.")
                : localized(language, "暂无账号或未使用邀请。", "No accounts or unused invites.")}
          </p>
        ) : null}
      </div>
    </div>
  );
}
