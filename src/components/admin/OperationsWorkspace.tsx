import {
  ArrowLeft,
  ArrowsClockwise,
  Broadcast,
  CaretDown,
  ChartLine,
  ChatCircleText,
  Flask,
  GearSix,
  ListChecks,
  RocketLaunch,
  ShieldCheck,
  UserCircle,
  Users
} from "@phosphor-icons/react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { AccountSessionControls } from "../AccountBar";
import { LanguageToggle, useLanguage } from "../LanguageToggle";
import { localized } from "../../lib/i18n";
import { CONNECTION_LABELS, CONNECTION_LABELS_EN } from "../../lib/constants";
import type { HelmetAgent } from "../../hooks/useHelmetAgent";
import type { AuthUser } from "../../lib/auth";
import {
  adminRoleLabel,
  allowedAdminSections,
  allowedTestingSections,
  formatAdminRelativeTime,
  normalizeAdminSection,
  workspaceSectionLabel,
  type Workspace
} from "./admin-model";
import { useWorkspaceLocation } from "./workspace-location";
import { AccountManagement } from "./AccountManagement";
import { AdminOverview } from "./AdminOverview";
import { QualityOverview } from "./QualityOverview";
import { EvidenceWorkspace } from "./EvidenceWorkspace";
import { GovernanceWorkspace } from "./GovernanceWorkspace";
import { ReleaseValidation } from "./ReleaseValidation";
import { TestingOverview } from "./TestingOverview";
import { TestPlans } from "./TestPlans";
import { useAdminTestingData } from "./useAdminTestingData";

const SECTION_ICONS = {
  overview: ChartLine,
  plans: ListChecks,
  evidence: ChatCircleText,
  quality: ChartLine,
  releases: RocketLaunch,
  diagnostics: GearSix,
  policies: GearSix,
  accounts: Users,
  audit: ShieldCheck
};

type Props = {
  agent: HelmetAgent;
  user: AuthUser;
  onAuthenticationExpired: () => void;
  onClose: () => boolean;
};

export function OperationsWorkspace({ agent, user, onAuthenticationExpired, onClose }: Props) {
  const { language } = useLanguage();
  const location = useWorkspaceLocation();
  const { section, navigate } = location;
  const canAdminister = user.role === "admin";
  const canManageTesting = user.role === "admin" || user.role === "reviewer";
  const workspace: Workspace = location.isAdmin && canAdminister ? "admin" : "testing";
  const allowed = workspace === "admin" ? allowedAdminSections(user.role) : allowedTestingSections(user.role);
  const active =
    workspace === "admin"
      ? normalizeAdminSection(section, user.role)
      : allowed.includes(section)
        ? section
        : "overview";
  const [requestedEvidenceSessionId, setRequestedEvidenceSessionId] = useState<string | null>(null);
  const [evidenceFocusRequestKey, setEvidenceFocusRequestKey] = useState(0);
  const accountScope = `${user.id}:${user.role}`;
  const [refreshing, setRefreshing] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const profileRef = useRef<HTMLDetailsElement>(null);
  const needsTestingData = workspace === "testing" || active === "audit";
  const data = useAdminTestingData({ user, onAuthenticationExpired, enabled: needsTestingData });
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
    if (!location.isWorkspace) return;
    if (location.workspace !== workspace || section !== active) navigate(active, {}, true, workspace);
  }, [active, section, navigate, workspace, location.workspace, location.isWorkspace]);

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

  const openSessions = (filters: Record<string, string | null> = {}) => {
    setRequestedEvidenceSessionId(filters.session ?? null);
    setEvidenceFocusRequestKey((current) => current + 1);
    navigate("evidence", filters, false, "testing");
  };
  const refresh = async () => {
    setRefreshing(true);
    try {
      await data.refresh();
      if (workspace === "testing") await agent.refreshHealth();
    } finally {
      setRefreshing(false);
    }
  };
  const administration = workspace === "admin";
  const title = workspaceSectionLabel(active, language);

  return (
    <main className={`adminWorkspace ${administration ? "adminControlWorkspace" : "testingWorkspace"}`}>
      <header className="adminWorkspaceHeader">
        <div className="adminWorkspaceBrand">
          <span className="adminWorkspaceLogo">
            {administration ? <ShieldCheck aria-hidden="true" /> : <Flask aria-hidden="true" />}
          </span>
          <div>
            <small>{administration ? "MAX ADMIN" : "MAX TESTING"}</small>
            <h1>
              {administration ? localized(language, "管理", "Administration") : localized(language, "测试", "Testing")}
            </h1>
          </div>
        </div>
        <div className="adminWorkspaceContext">
          {!administration ? (
            <span className={`adminVoiceContext ${agent.connectionState === "ready" ? "online" : ""}`}>
              <Broadcast aria-hidden="true" /> {voiceConnectionLabel}
            </span>
          ) : null}
          {canAdminister ? (
            <a
              className="workspaceSwitch"
              href={`#/${administration ? "testing" : "admin"}/overview`}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                navigate("overview", {}, false, administration ? "testing" : "admin");
              }}
            >
              {administration ? <Flask aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}
              {administration
                ? localized(language, "进入测试", "Open testing")
                : localized(language, "进入管理", "Open administration")}
            </a>
          ) : null}
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
              <AccountSessionControls
                user={user}
                onSignedOut={onAuthenticationExpired}
                showConnectionToken={administration || user.role === "reviewer"}
              />
            </div>
          </details>
        </div>
      </header>
      <div className="adminWorkspaceLayout">
        <nav
          className="adminWorkspaceNav"
          aria-label={
            administration
              ? localized(language, "管理工作区", "Administration workspace")
              : localized(language, "测试工作区", "Testing workspace")
          }
        >
          <span className="adminNavCaption">
            {administration
              ? localized(language, "管理工具", "Management")
              : localized(language, "日常测试", "Everyday testing")}
          </span>
          <div className="adminWorkspaceNavTabs">
            {allowed.map((item) => {
              const Icon = SECTION_ICONS[item];
              return (
                <Fragment key={item}>
                  {!administration && item === "quality" ? (
                    <span className="adminNavCaption">{localized(language, "质量管理", "QA tools")}</span>
                  ) : null}
                  <a
                    href={`#/${workspace}/${item}`}
                    className={active === item ? "active" : ""}
                    aria-current={active === item ? "page" : undefined}
                    onClick={(event) => {
                      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                      event.preventDefault();
                      navigate(item, {}, false, workspace);
                    }}
                  >
                    <Icon size={20} aria-hidden="true" /> {workspaceSectionLabel(item, language)}
                  </a>
                </Fragment>
              );
            })}
          </div>
        </nav>
        <section className="adminWorkspaceContent">
          <div className="adminPageHeading">
            <div>
              <span>
                {administration
                  ? localized(language, "管理工作区", "Administration workspace")
                  : localized(language, "测试工作区", "Testing workspace")}
              </span>
              <h2>{title}</h2>
            </div>
            {needsTestingData ? (
              <div className="adminSyncControls">
                <small aria-live="polite">
                  {data.lastSyncedAt
                    ? `${localized(language, "最近更新", "Last updated")} ${formatAdminRelativeTime(data.lastSyncedAt, language)}`
                    : localized(language, "正在获取数据", "Getting your data")}
                </small>
                <button type="button" onClick={() => void refresh()} disabled={refreshing || data.status === "loading"}>
                  <ArrowsClockwise aria-hidden="true" />{" "}
                  {refreshing ? localized(language, "更新中…", "Updating…") : localized(language, "刷新", "Refresh")}
                </button>
              </div>
            ) : null}
          </div>
          {needsTestingData && data.error ? (
            <div className={`adminSyncNotice ${data.error.kind}`} role="status">
              <strong>
                {data.status === "stale"
                  ? localized(language, "显示的是上次更新的记录", "Showing previously updated records")
                  : localized(language, "暂时无法获取记录", "Unable to get records right now")}
              </strong>
              <span>
                {administration
                  ? data.error.message
                  : localized(
                      language,
                      "请刷新后重试。已保存的记录不会丢失。",
                      "Try refreshing. Your saved records have not been lost."
                    )}
              </span>
              {data.error.kind !== "unauthorized" ? (
                <button type="button" onClick={() => void refresh()} disabled={refreshing}>
                  {localized(language, "重试", "Retry")}
                </button>
              ) : null}
            </div>
          ) : null}
          {!administration && active === "overview" ? (
            <TestingOverview
              user={user}
              data={data}
              onOpenSessions={openSessions}
              onOpenPlans={() => navigate("plans", {}, false, "testing")}
              onStartTesting={onClose}
            />
          ) : null}
          {!administration && active === "plans" ? (
            <TestPlans
              user={user}
              agent={agent}
              data={data}
              onOpenSessions={openSessions}
              onStartTesting={(prepare) => {
                if (onClose()) prepare?.();
              }}
            />
          ) : null}
          {!administration && active === "quality" && !data.testing ? (
            <p className="adminWorkspaceLoading">
              {data.status === "loading"
                ? localized(language, "正在加载概览…", "Loading overview…")
                : localized(language, "暂无可用概览数据。", "No overview data available.")}
            </p>
          ) : null}
          {!administration && active === "quality" && data.testing ? (
            <QualityOverview
              agent={agent}
              testing={data.testing}
              sessions={data.sessions}
              operations={data.operations}
              runs={data.runs}
              dataStatus={data.status}
              onOpenEvidence={(sessionId, filters = {}) => openSessions({ ...filters, session: sessionId ?? null })}
              onOpenReleases={(runId) => navigate("releases", { run: runId ?? null }, false, "testing")}
            />
          ) : null}
          {administration && active === "overview" ? (
            <AdminOverview
              key={accountScope}
              user={user}
              onAuthenticationExpired={onAuthenticationExpired}
              onOpenAccounts={() => navigate("accounts", {}, false, "admin")}
              onOpenAudit={() => navigate("audit", {}, false, "admin")}
            />
          ) : null}
          <EvidenceWorkspace
            active={!administration && (active === "evidence" || active === "diagnostics")}
            technical={!administration && active === "diagnostics" && canManageTesting}
            focusRequestKey={evidenceFocusRequestKey}
            requestedSessionId={requestedEvidenceSessionId}
            onRequestedSessionHandled={handleRequestedSessionHandled}
            agent={agent}
            user={user}
            data={data}
          />
          {canManageTesting ? (
            <div
              className="adminSectionView"
              hidden={administration || active !== "releases"}
              inert={administration || active !== "releases" ? true : undefined}
            >
              <ReleaseValidation key={accountScope} agent={agent} user={user} data={data} />
            </div>
          ) : null}
          {canManageTesting ? (
            <div
              className="adminSectionView"
              hidden={administration || active !== "policies"}
              inert={administration || active !== "policies" ? true : undefined}
            >
              <GovernanceWorkspace key={`${accountScope}:policy`} view="policy" user={user} data={data} />
            </div>
          ) : null}
          {administration && active === "accounts" ? (
            <AccountManagement key={accountScope} user={user} onAuthenticationExpired={onAuthenticationExpired} />
          ) : null}
          {canAdminister ? (
            <div
              className="adminSectionView"
              hidden={!administration || active !== "audit"}
              inert={!administration || active !== "audit" ? true : undefined}
            >
              <GovernanceWorkspace key={`${accountScope}:audit`} view="audit" user={user} data={data} />
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}
