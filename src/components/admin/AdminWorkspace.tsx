import { ArrowLeft, Broadcast, ShieldCheck } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AccountSessionControls } from "../AccountBar";
import type { HelmetAgent } from "../../hooks/useHelmetAgent";
import type { AuthUser } from "../../lib/auth";
import {
  ADMIN_SECTION_LABELS,
  adminRoleLabel,
  allowedAdminSections,
  formatAdminRelativeTime,
  normalizeAdminSection,
  type AdminSection
} from "./admin-model";
import { AccountManagement } from "./AccountManagement";
import { AdminOverview } from "./AdminOverview";
import { EvidenceWorkspace } from "./EvidenceWorkspace";
import { GovernanceWorkspace } from "./GovernanceWorkspace";
import { ReleaseValidation } from "./ReleaseValidation";
import { useAdminTestingData } from "./useAdminTestingData";

type Props = {
  agent: HelmetAgent;
  user: AuthUser;
  onAuthenticationExpired: () => void;
  onClose: () => void;
};

export function AdminWorkspace({ agent, user, onAuthenticationExpired, onClose }: Props) {
  const [section, setSection] = useState<AdminSection>("overview");
  const [requestedEvidenceSessionId, setRequestedEvidenceSessionId] = useState<string | null>(null);
  const [evidenceFocusRequestKey, setEvidenceFocusRequestKey] = useState(0);
  const closeRef = useRef<HTMLButtonElement>(null);
  const data = useAdminTestingData({ user, onAuthenticationExpired });
  const allowed = allowedAdminSections(user.role);
  const active = normalizeAdminSection(section, user.role);
  const handleRequestedSessionHandled = useCallback((sessionId: string) => {
    setRequestedEvidenceSessionId((current) => (current === sessionId ? null : current));
  }, []);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [onClose]);

  return (
    <main className="adminWorkspace">
      <header className="adminWorkspaceHeader">
        <div className="adminWorkspaceBrand">
          <span className="adminWorkspaceLogo">M</span>
          <div>
            <small>MAX QA</small>
            <h1>测试与管理</h1>
          </div>
        </div>
        <div className="adminWorkspaceContext">
          <span className={agent.connected ? "online" : ""}>
            <Broadcast aria-hidden="true" /> {agent.connected ? "中继在线" : "中继离线"}
          </span>
          <span>构建 {agent.health?.build?.gitCommit ?? "本地"}</span>
          <span>
            <ShieldCheck aria-hidden="true" /> @{user.username} · {adminRoleLabel(user.role)}
          </span>
          <small>{data.lastSyncedAt ? `最近同步 ${formatAdminRelativeTime(data.lastSyncedAt)}` : "等待首次同步"}</small>
          <button ref={closeRef} type="button" onClick={onClose}>
            <ArrowLeft aria-hidden="true" /> 返回 Max
          </button>
        </div>
      </header>
      <div className="adminWorkspaceLayout">
        <nav className="adminWorkspaceNav" aria-label="Admin 工作区">
          {allowed.map((item) => (
            <button
              type="button"
              key={item}
              className={active === item ? "active" : ""}
              aria-current={active === item ? "page" : undefined}
              onClick={() => setSection(item)}
            >
              {ADMIN_SECTION_LABELS[item]}
            </button>
          ))}
          <AccountSessionControls user={user} onSignedOut={onAuthenticationExpired} />
        </nav>
        <section className="adminWorkspaceContent">
          {data.error ? (
            <div className={`adminSyncNotice ${data.error.kind}`} role="status">
              <strong>{data.status === "stale" ? "数据可能已过期" : "加载失败"}</strong>
              <span>{data.error.message}</span>
              {data.error.kind !== "unauthorized" ? (
                <button type="button" onClick={() => void data.refresh()}>
                  重试
                </button>
              ) : null}
            </div>
          ) : null}
          {active === "overview" && !data.testing ? (
            <p className="adminWorkspaceLoading">
              {data.status === "loading" ? "正在加载概览…" : "暂无可用概览数据。"}
            </p>
          ) : null}
          {active === "overview" && data.testing ? (
            <AdminOverview
              agent={agent}
              testing={data.testing}
              sessions={data.sessions}
              operations={data.operations}
              onOpenEvidence={(sessionId) => {
                setRequestedEvidenceSessionId(sessionId ?? null);
                setEvidenceFocusRequestKey((current) => current + 1);
                setSection("evidence");
              }}
              onOpenReleases={() => setSection("releases")}
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
          {active === "releases" ? <ReleaseValidation agent={agent} user={user} data={data} /> : null}
          {active === "governance" ? <GovernanceWorkspace user={user} data={data} /> : null}
          {active === "accounts" && user.role === "admin" ? (
            <AccountManagement user={user} onAuthenticationExpired={onAuthenticationExpired} />
          ) : null}
        </section>
      </div>
    </main>
  );
}
