import {
  ArrowLeft,
  ArrowsClockwise,
  Broadcast,
  CaretDown,
  ChartLine,
  GearSix,
  ListChecks,
  RocketLaunch,
  ShieldCheck,
  UserCircle,
  Users
} from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AccountSessionControls } from "../AccountBar";
import { LanguageToggle, useLanguage } from "../LanguageToggle";
import { localized } from "../../lib/i18n";
import { CONNECTION_LABELS, CONNECTION_LABELS_EN } from "../../lib/constants";
import type { HelmetAgent } from "../../hooks/useHelmetAgent";
import type { AuthUser } from "../../lib/auth";
import {
  adminRoleLabel,
  allowedAdminSections,
  formatAdminRelativeTime,
  normalizeAdminSection,
  adminSectionLabel
} from "./admin-model";
import { useAdminLocation } from "./admin-location";
import { AccountManagement } from "./AccountManagement";
import { AdminOverview } from "./AdminOverview";
import { EvidenceWorkspace } from "./EvidenceWorkspace";
import { GovernanceWorkspace } from "./GovernanceWorkspace";
import { ReleaseValidation } from "./ReleaseValidation";
import { useAdminTestingData } from "./useAdminTestingData";

const SECTION_ICONS = {
  overview: ChartLine,
  releases: RocketLaunch,
  evidence: ListChecks,
  accounts: Users,
  governance: GearSix
};

type Props = {
  agent: HelmetAgent;
  user: AuthUser;
  onAuthenticationExpired: () => void;
  onClose: () => void;
};

export function AdminWorkspace({ agent, user, onAuthenticationExpired, onClose }: Props) {
  const { language } = useLanguage();
  const { section, navigate } = useAdminLocation();
  const [requestedEvidenceSessionId, setRequestedEvidenceSessionId] = useState<string | null>(null);
  const [evidenceFocusRequestKey, setEvidenceFocusRequestKey] = useState(0);
  const accountScope = `${user.id}:${user.role}`;
  const [refreshing, setRefreshing] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const profileRef = useRef<HTMLDetailsElement>(null);
  const data = useAdminTestingData({ user, onAuthenticationExpired });
  const allowed = allowedAdminSections(user.role);
  const active = normalizeAdminSection(section, user.role);
  const voiceConnectionLabel =
    agent.connectionState === "offline" && !agent.listening
      ? agent.starting
        ? localized(language, "语音启动中", "Voice starting")
        : localized(language, "语音会话未开启", "Voice session inactive")
      : `${localized(language, "语音", "Voice")} · ${(language === "en-US" ? CONNECTION_LABELS_EN : CONNECTION_LABELS)[agent.connectionState]}`;
  const handleRequestedSessionHandled = useCallback((sessionId: string) => {
    setRequestedEvidenceSessionId((current) => (current === sessionId ? null : current));
  }, []);

  useEffect(() => {
    if (section !== active) navigate(active, {}, true);
  }, [active, section, navigate]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && profileRef.current?.open) {
        profileRef.current.open = false;
        profileRef.current.querySelector("summary")?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, []);

  const openEvidence = (sessionId?: string, filters: Record<string, string | null> = {}) => {
    setRequestedEvidenceSessionId(sessionId ?? null);
    setEvidenceFocusRequestKey((current) => current + 1);
    navigate("evidence", { ...filters, session: sessionId ?? null });
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      await data.refresh();
      await agent.refreshHealth();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <main className="adminWorkspace">
      <header className="adminWorkspaceHeader">
        <div className="adminWorkspaceBrand">
          <span className="adminWorkspaceLogo">M</span>
          <div>
            <small>MAX OPERATIONS</small>
            <h1>{localized(language, "测试与管理", "Testing & Admin")}</h1>
          </div>
        </div>
        <div className="adminWorkspaceContext">
          <span className={`adminVoiceContext ${agent.connectionState === "ready" ? "online" : ""}`}>
            <Broadcast aria-hidden="true" /> {voiceConnectionLabel}
          </span>
          <button ref={closeRef} type="button" className="adminBackAction" onClick={onClose}>
            <ArrowLeft aria-hidden="true" /> {localized(language, "返回 Max", "Back to Max")}
          </button>
          <details className="adminProfile" ref={profileRef}>
            <summary aria-label={localized(language, "账号与偏好", "Account & preferences")}>
              <UserCircle size={24} aria-hidden="true" />
              <span>{user.displayName || user.username}</span>
              <CaretDown aria-hidden="true" />
            </summary>
            <div className="adminProfileMenu">
              <p>
                <ShieldCheck aria-hidden="true" /> {adminRoleLabel(user.role, language)}
              </p>
              <LanguageToggle />
              <AccountSessionControls user={user} onSignedOut={onAuthenticationExpired} />
            </div>
          </details>
        </div>
      </header>
      <div className="adminWorkspaceLayout">
        <nav className="adminWorkspaceNav" aria-label={localized(language, "管理工作区", "Admin workspace")}>
          <span className="adminNavCaption">{localized(language, "工作区", "Workspace")}</span>
          <div className="adminWorkspaceNavTabs">
            {allowed.map((item) => {
              const Icon = SECTION_ICONS[item];
              return (
                <a
                  key={item}
                  href={`#/admin/${item}`}
                  className={active === item ? "active" : ""}
                  aria-current={active === item ? "page" : undefined}
                  onClick={(event) => {
                    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                    event.preventDefault();
                    navigate(item);
                  }}
                >
                  <Icon size={20} aria-hidden="true" /> {adminSectionLabel(item, language)}
                </a>
              );
            })}
          </div>
          <div className="adminNavBuild">
            <span>{localized(language, "当前构建", "Current build")}</span>
            <code>{agent.health?.build?.gitCommit ?? localized(language, "本地", "Local")}</code>
          </div>
        </nav>
        <section className="adminWorkspaceContent">
          <div className="adminPageHeading">
            <div>
              <span>{localized(language, "MAX 工作区", "MAX workspace")}</span>
              <h2>{adminSectionLabel(active, language)}</h2>
            </div>
            <div className="adminSyncControls">
              <small aria-live="polite">
                {data.lastSyncedAt
                  ? `${localized(language, "最近同步", "Last synced")} ${formatAdminRelativeTime(data.lastSyncedAt, language)}`
                  : localized(language, "等待首次同步", "Waiting for first sync")}
              </small>
              <button type="button" onClick={() => void refresh()} disabled={refreshing || data.status === "loading"}>
                <ArrowsClockwise aria-hidden="true" />{" "}
                {refreshing ? localized(language, "同步中…", "Syncing…") : localized(language, "刷新", "Refresh")}
              </button>
            </div>
          </div>
          {data.error ? (
            <div className={`adminSyncNotice ${data.error.kind}`} role="status">
              <strong>
                {data.status === "stale"
                  ? localized(language, "数据可能已过期", "Data may be stale")
                  : localized(language, "加载失败", "Unable to load data")}
              </strong>
              <span>{data.error.message}</span>
              {data.error.kind !== "unauthorized" ? (
                <button type="button" onClick={() => void refresh()} disabled={refreshing}>
                  {localized(language, "重试", "Retry")}
                </button>
              ) : null}
            </div>
          ) : null}
          {active === "overview" && !data.testing ? (
            <p className="adminWorkspaceLoading">
              {data.status === "loading"
                ? localized(language, "正在加载概览…", "Loading overview…")
                : localized(language, "暂无可用概览数据。", "No overview data available.")}
            </p>
          ) : null}
          {active === "overview" && data.testing ? (
            <AdminOverview
              agent={agent}
              testing={data.testing}
              sessions={data.sessions}
              operations={data.operations}
              runs={data.runs}
              dataStatus={data.status}
              onOpenEvidence={openEvidence}
              onOpenReleases={(runId) => navigate("releases", { run: runId ?? null })}
            />
          ) : null}
          <EvidenceWorkspace
            active={active === "evidence"}
            focusRequestKey={evidenceFocusRequestKey}
            requestedSessionId={requestedEvidenceSessionId}
            onRequestedSessionHandled={handleRequestedSessionHandled}
            agent={agent}
            user={user}
            data={data}
          />
          <div
            className="adminSectionView"
            hidden={active !== "releases"}
            inert={active !== "releases" ? true : undefined}
          >
            <ReleaseValidation key={accountScope} agent={agent} user={user} data={data} />
          </div>
          {user.role !== "tester" ? (
            <div
              className="adminSectionView"
              hidden={active !== "governance"}
              inert={active !== "governance" ? true : undefined}
            >
              <GovernanceWorkspace key={accountScope} user={user} data={data} />
            </div>
          ) : null}
          {user.role === "admin" ? (
            <div
              className="adminSectionView"
              hidden={active !== "accounts"}
              inert={active !== "accounts" ? true : undefined}
            >
              <AccountManagement key={accountScope} user={user} onAuthenticationExpired={onAuthenticationExpired} />
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}
