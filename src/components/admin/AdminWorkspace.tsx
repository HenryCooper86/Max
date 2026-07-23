import { ArrowLeft, Broadcast, ShieldCheck } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { AccountBar } from "../AccountBar";
import type { HelmetAgent } from "../../hooks/useHelmetAgent";
import type { AuthUser } from "../../lib/auth";
import {
  ADMIN_SECTION_LABELS,
  adminRoleLabel,
  allowedAdminSections,
  normalizeAdminSection,
  type AdminSection
} from "./admin-model";

function ignoreSignedIn() {}

type Props = {
  agent: HelmetAgent;
  user: AuthUser;
  onAuthenticationExpired: () => void;
  onClose: () => void;
};

export function AdminWorkspace({ agent, user, onAuthenticationExpired, onClose }: Props) {
  const [section, setSection] = useState<AdminSection>("overview");
  const closeRef = useRef<HTMLButtonElement>(null);
  const allowed = allowedAdminSections(user.role);
  const active = normalizeAdminSection(section, user.role);

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
          <span>
            <ShieldCheck aria-hidden="true" /> @{user.username} · {adminRoleLabel(user.role)}
          </span>
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
          {/* Task 8 replaces this compatibility bridge with authenticated-only AccountSessionControls. */}
          <AccountBar
            authEnabled
            registrationOpen={false}
            user={user}
            onSignedIn={ignoreSignedIn}
            onSignedOut={onAuthenticationExpired}
          />
        </nav>
        <section className="adminWorkspaceContent" aria-live="polite">
          <p className="adminWorkspaceLoading">正在加载 {ADMIN_SECTION_LABELS[active]}…</p>
        </section>
      </div>
    </main>
  );
}
