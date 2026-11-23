import { useCallback, useEffect, useRef, useState } from "react";
import { adminAccountApi, type AdminOverview as AccountOverviewData, type AuthUser } from "../../lib/auth";
import { useLanguage } from "../LanguageToggle";
import { localized, type Language } from "../../lib/i18n";
import { StudioActivationPanel } from "./StudioActivationPanel";
import { adminRoleLabel, formatAdminRelativeTime } from "./admin-model";

const INVITE_EXPIRING_SOON_MS = 2 * 24 * 60 * 60 * 1000;
const RECENT_ACCOUNT_LIMIT = 5;
const RECENT_INVITE_LIMIT = 4;

type LoadStatus = "loading" | "ready" | "stale";

/** Mirrors AccountManagement's expiry copy: absolute date plus countdown so an
 * admin never has to do date math before nudging an invite. */
function formatInviteExpiry(timestamp: number, language: Language) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "—";
  const absolute = new Intl.DateTimeFormat(language === "en-US" ? "en-US" : "zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
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

/**
 * Administration home. Accounts, system audit, and Studio activation
 * come from the relay's admin overview. This
 * surface deliberately has no dependency on testing snapshots, sessions,
 * release gates, latency, case coverage or testing policies — those live in
 * the Testing workspace.
 */
export function AdminOverview({
  user,
  onAuthenticationExpired,
  onOpenAccounts,
  onOpenAudit
}: {
  user: AuthUser;
  onAuthenticationExpired: () => void;
  onOpenAccounts: () => void;
  onOpenAudit: () => void;
}) {
  const { language } = useLanguage();
  const [overview, setOverview] = useState<AccountOverviewData | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [loadNotice, setLoadNotice] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const accountOwnerRef = useRef(user.id);
  const loadSequenceRef = useRef(0);
  const authenticationExpiredRef = useRef(onAuthenticationExpired);
  authenticationExpiredRef.current = onAuthenticationExpired;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadSequenceRef.current += 1;
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
      // A failed fetch must never masquerade as a healthy empty account list.
      setStatus("stale");
      if (result.error.kind === "unauthorized") {
        authenticationExpiredRef.current();
      } else {
        setLoadNotice(result.error.message);
      }
      return false;
    },
    [ownsAccount]
  );

  useEffect(() => {
    const ownerId = user.id;
    accountOwnerRef.current = ownerId;
    loadSequenceRef.current += 1;
    setOverview(null);
    setStatus("loading");
    setLoadNotice(null);
    void refresh(ownerId);
    const timer = window.setInterval(() => void refresh(ownerId), 30_000);
    return () => {
      window.clearInterval(timer);
      loadSequenceRef.current += 1;
    };
  }, [refresh, user.id]);

  const users = overview?.users ?? [];
  const roleCounts = {
    admin: users.filter((account) => account.role === "admin").length,
    reviewer: users.filter((account) => account.role === "reviewer").length,
    tester: users.filter((account) => account.role === "tester").length
  };
  const now = Date.now();
  const invites = [...(overview?.invites ?? [])].sort((a, b) => a.expiresAt - b.expiresAt);
  const usableInvites = invites.filter((item) => item.expiresAt - now > 0);
  const expiredInviteCount = invites.length - usableInvites.length;
  const expiringSoonCount = usableInvites.filter((item) => item.expiresAt - now <= INVITE_EXPIRING_SOON_MS).length;
  const recentAccounts = [...users].sort((a, b) => b.lastLoginAt - a.lastLoginAt).slice(0, RECENT_ACCOUNT_LIMIT);
  const hasData = overview !== null;

  return (
    <section
      className="adminSectionCard adminOverview"
      aria-label={localized(language, "系统管理概览", "Administration overview")}
      data-load-status={status}
    >
      <div className="panelHeader adminSectionHeader">
        <div>
          <h2>{localized(language, "系统管理", "Administration")}</h2>
          <span>
            {hasData
              ? language === "en-US"
                ? `${users.length} accounts · ${usableInvites.length} usable invites`
                : `${users.length} 个账号 · ${usableInvites.length} 个可用邀请`
              : status === "loading"
                ? localized(language, "正在加载账号数据…", "Loading account data…")
                : localized(language, "暂时无法加载账号数据。", "Account data is temporarily unavailable.")}
          </span>
        </div>
      </div>

      {status === "stale" ? (
        <p className="adminNotice" role="status">
          {localized(language, "数据可能已过期", "Data may be stale")}
        </p>
      ) : null}
      {loadNotice ? (
        <p className="adminNotice" role="alert">
          {loadNotice}
        </p>
      ) : null}

      {hasData ? (
        <>
          <div className="adminAccountSummary" aria-label={localized(language, "账号概览", "Account overview")}>
            <span>
              <b>{users.length}</b>
              {localized(language, "账号", "Accounts")}
            </span>
            <span>
              <b>{roleCounts.admin}</b>
              {localized(language, "管理员", "Administrators")}
            </span>
            <span>
              <b>{roleCounts.reviewer}</b>
              {localized(language, "审核员", "Reviewers")}
            </span>
            <span>
              <b>{roleCounts.tester}</b>
              {localized(language, "测试员", "Testers")}
            </span>
            <span className={expiringSoonCount ? "warn" : ""}>
              <b>{usableInvites.length}</b>
              {localized(language, "可用邀请", "Usable invites")}
            </span>
          </div>

          {overview.studioActivation !== undefined && (
            <StudioActivationPanel metrics={overview.studioActivation} language={language} />
          )}

          <div className="testingDecisionGrid adminWorkGrid">
            <section
              className="decisionPanel adminSectionCard adminSectionInset"
              aria-label={localized(language, "近期账号", "Recent accounts")}
            >
              <div className="decisionPanelHead">
                <span>{localized(language, "近期账号", "Recent accounts")}</span>
                <button type="button" onClick={onOpenAccounts}>
                  {localized(language, "管理账号与邀请", "Manage accounts & invites")}
                </button>
              </div>
              <div className="adminAccountList">
                <section className="adminAccountGroup" aria-label={localized(language, "用户", "Users")}>
                  {recentAccounts.map((account) => (
                    <div className="accountAdminRow" key={account.id}>
                      <div className="adminAccountUser">
                        <strong>
                          {account.displayName}
                          {account.username === user.username ? (
                            <span className="adminAccountSelf">
                              {localized(language, "当前账号", "Current account")}
                            </span>
                          ) : null}
                        </strong>
                        <span>
                          @{account.username} · {adminRoleLabel(account.role, language)} ·{" "}
                          {language === "en-US" ? "Joined " : "加入于 "}
                          {formatAdminRelativeTime(account.createdAt, language)} ·{" "}
                          {language === "en-US" ? "Last login " : "最近登录 "}
                          {formatAdminRelativeTime(account.lastLoginAt, language)}
                        </span>
                      </div>
                    </div>
                  ))}
                  {!recentAccounts.length ? (
                    <p className="testerConversationEmpty">{localized(language, "暂无账号。", "No accounts yet.")}</p>
                  ) : null}
                </section>
              </div>
            </section>

            <section
              className="decisionPanel adminSectionCard adminSectionInset"
              aria-label={localized(language, "邀请与系统审计", "Invites and system audit")}
            >
              <div className="decisionPanelHead">
                <span>{localized(language, "邀请与系统审计", "Invites and system audit")}</span>
                <button type="button" onClick={onOpenAudit}>
                  {localized(language, "查看系统审计", "View system audit")}
                </button>
              </div>
              <div className="adminAccountList">
                <section className="adminAccountGroup" aria-label={localized(language, "可用邀请", "Usable invites")}>
                  <h4 className="adminAccountGroupHead">
                    {localized(language, "可用邀请", "Usable invites")}
                    <span className={expiringSoonCount ? "warn" : ""}>
                      {usableInvites.length} / {invites.length}
                      {expiringSoonCount
                        ? localized(
                            language,
                            ` · ${expiringSoonCount} 即将过期`,
                            ` · ${expiringSoonCount} expiring soon`
                          )
                        : ""}
                    </span>
                  </h4>
                  {usableInvites.slice(0, RECENT_INVITE_LIMIT).map((item) => {
                    const remainingMs = item.expiresAt - now;
                    const expiringSoon = remainingMs <= INVITE_EXPIRING_SOON_MS;
                    return (
                      <div className="accountAdminRow invite" key={item.code}>
                        <div className="adminAccountUser">
                          <strong>
                            {localized(language, "邀请", "Invite")} · {item.code.slice(4, 12)}…
                            <span className={`inviteStatus${expiringSoon ? " warn" : ""}`}>
                              {expiringSoon
                                ? localized(language, "即将过期", "Expiring soon")
                                : localized(language, "未使用", "Unused")}
                            </span>
                          </strong>
                          <span>
                            {localized(language, "由", "Created by")} {item.createdBy}{" "}
                            {localized(language, "创建", "created")} ·{" "}
                            {formatAdminRelativeTime(item.createdAt, language)} ·{" "}
                            {localized(language, "过期", "Expires")} {formatInviteExpiry(item.expiresAt, language)}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                  {expiredInviteCount ? (
                    <p className="testerConversationEmpty">
                      {localized(
                        language,
                        `另有 ${expiredInviteCount} 个已过期邀请。`,
                        `${expiredInviteCount} more invite${expiredInviteCount === 1 ? "" : "s"} already expired.`
                      )}
                    </p>
                  ) : null}
                  {!usableInvites.length && !expiredInviteCount ? (
                    <p className="testerConversationEmpty">
                      {localized(language, "暂无未使用邀请。", "No unused invites.")}
                    </p>
                  ) : null}
                </section>

                <section className="adminAccountGroup" aria-label={localized(language, "系统审计", "System audit")}>
                  <div className="accountAdminRow">
                    <div className="adminAccountUser">
                      <strong>{localized(language, "系统审计", "System audit")}</strong>
                      <span>
                        {localized(
                          language,
                          "账号变更、角色调整与治理操作的完整记录。",
                          "Complete record of account changes, role adjustments, and governance actions."
                        )}
                      </span>
                    </div>
                  </div>
                </section>
              </div>
            </section>
          </div>
        </>
      ) : (
        <p className="testerConversationEmpty">
          {status === "loading"
            ? localized(language, "正在加载账号数据…", "Loading account data…")
            : localized(language, "暂时无法加载账号数据。", "Account data is temporarily unavailable.")}
        </p>
      )}
    </section>
  );
}
