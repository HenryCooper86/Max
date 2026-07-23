import { useEffect, useState } from "react";
import type { TestingAuditEvent } from "../../../shared/testing";
import type { AuthUser } from "../../lib/auth";
import { useLanguage } from "../LanguageToggle";
import { localized } from "../../lib/i18n";
import { formatAdminRelativeTime } from "./admin-model";
import type { AdminTestingData } from "./useAdminTestingData";

type GovernanceTab = "policy" | "audit";
type Notice = { tone: "success" | "error"; message: string };

type Props = {
  user: AuthUser;
  data: AdminTestingData;
};

function detailValue(value: unknown) {
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function auditDetail(event: TestingAuditEvent) {
  const entries = Object.entries(event.detail);
  if (!entries.length) return "暂无额外详情";
  return entries.map(([key, value]) => `${key}: ${detailValue(value)}`).join(" · ");
}

export function GovernanceWorkspace({ user, data }: Props) {
  const { language } = useLanguage();
  const [tab, setTab] = useState<GovernanceTab>("policy");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [publishing, setPublishing] = useState(false);
  const activePolicy = data.operations?.activePolicy;
  const [policyDescription, setPolicyDescription] = useState("");
  const [policyLatency, setPolicyLatency] = useState(activePolicy?.release.maxP95LatencyMs ?? 800);
  const [policyInvalid, setPolicyInvalid] = useState(activePolicy?.release.maxInvalidSessions ?? 0);
  const [policySafetySamples, setPolicySafetySamples] = useState(activePolicy?.release.minSafetyCriticalSessions ?? 3);
  const isAdmin = user.role === "admin";
  const activePolicyVersion = activePolicy?.version;
  const activePolicyLatency = activePolicy?.release.maxP95LatencyMs;
  const activePolicyInvalid = activePolicy?.release.maxInvalidSessions;
  const activePolicySafetySamples = activePolicy?.release.minSafetyCriticalSessions;

  useEffect(() => {
    if (
      activePolicyLatency === undefined ||
      activePolicyInvalid === undefined ||
      activePolicySafetySamples === undefined
    ) {
      return;
    }
    setPolicyLatency(activePolicyLatency);
    setPolicyInvalid(activePolicyInvalid);
    setPolicySafetySamples(activePolicySafetySamples);
    setPolicyDescription("");
  }, [activePolicyInvalid, activePolicyLatency, activePolicySafetySamples, activePolicyVersion]);

  const policyFieldsValid =
    Number.isFinite(policyLatency) &&
    policyLatency >= 100 &&
    Number.isFinite(policyInvalid) &&
    policyInvalid >= 0 &&
    Number.isFinite(policySafetySamples) &&
    policySafetySamples >= 1;

  const publishPolicy = async () => {
    if (!activePolicy || !isAdmin || !policyFieldsValid) return;
    setPublishing(true);
    setNotice(null);
    const result = await data.createPolicy({
      ...activePolicy,
      version: `${new Date().toISOString().slice(0, 10)}.${Date.now()}`,
      description: policyDescription.trim(),
      release: {
        ...activePolicy.release,
        maxP95LatencyMs: policyLatency,
        maxInvalidSessions: policyInvalid,
        minSafetyCriticalSessions: policySafetySamples
      }
    });
    if (result.ok) {
      setPolicyDescription("");
      setNotice({ tone: "success", message: `策略 ${result.data.version} 已发布并写入审计日志。` });
      await data.refresh();
    } else {
      setNotice({ tone: "error", message: result.error.message });
    }
    setPublishing(false);
  };

  return (
    <section
      className="testingControlPlane adminSectionCard"
      aria-label={localized(language, "策略与审计", "Policy & audit")}
    >
      <div className="controlPlaneHead adminSectionHeader">
        <div>
          <span>MAX QA · 治理</span>
          <strong>{localized(language, "策略与审计", "Policy & audit")}</strong>
        </div>
        <nav className="controlPlaneTabs" aria-label="治理视图">
          <button type="button" className={tab === "policy" ? "active" : ""} onClick={() => setTab("policy")}>
            {localized(language, "发布策略", "Publish policy")}
          </button>
          <button type="button" className={tab === "audit" ? "active" : ""} onClick={() => setTab("audit")}>
            {localized(language, "审计日志", "Audit log")}
          </button>
        </nav>
      </div>

      {notice ? (
        <p className={`adminNotice ${notice.tone}`} role="status">
          {notice.message}
        </p>
      ) : null}

      {!activePolicy ? (
        <p className="adminWorkspaceLoading">
          {data.status === "loading" ? "正在加载治理数据…" : "暂无可用策略数据。"}
        </p>
      ) : null}

      {tab === "policy" && activePolicy ? (
        <div className="policyWorkbench">
          <div className="activePolicyCard">
            <span>当前生效策略</span>
            <strong>{activePolicy.version}</strong>
            <p>{activePolicy.description}</p>
            <small>已批准基线：{data.operations?.approvedBaselineBuild ?? "尚未选择"}</small>
          </div>
          <div className="policyFields">
            <label>
              <span>{localized(language, "发布 P95 上限（ms）", "Release P95 limit (ms)")}</span>
              <input
                type="number"
                min={100}
                value={policyLatency}
                onChange={(event) => setPolicyLatency(Number(event.target.value))}
                disabled={!isAdmin}
              />
            </label>
            <label>
              <span>{localized(language, "允许的无效证据数", "Allowed invalid evidence")}</span>
              <input
                type="number"
                min={0}
                value={policyInvalid}
                onChange={(event) => setPolicyInvalid(Number(event.target.value))}
                disabled={!isAdmin}
              />
            </label>
            <label>
              <span>{localized(language, "每个安全用例最少样本", "Minimum samples per safety case")}</span>
              <input
                type="number"
                min={1}
                value={policySafetySamples}
                onChange={(event) => setPolicySafetySamples(Number(event.target.value))}
                disabled={!isAdmin}
              />
            </label>
            <label className="wide">
              <span>{localized(language, "变更理由", "Change reason")}</span>
              <textarea
                value={policyDescription}
                onChange={(event) => setPolicyDescription(event.target.value)}
                disabled={!isAdmin}
                placeholder={localized(
                  language,
                  "说明门槛调整及发布依据…",
                  "Explain threshold changes and release basis…"
                )}
              />
            </label>
            {isAdmin ? (
              <button
                type="button"
                disabled={publishing || !policyDescription.trim() || !policyFieldsValid}
                onClick={() => void publishPolicy()}
              >
                {publishing
                  ? localized(language, "正在发布…", "Publishing…")
                  : localized(language, "发布版本化策略", "Publish versioned policy")}
              </button>
            ) : (
              <p>
                {localized(
                  language,
                  "审核员拥有只读权限；策略变更与发布仅限管理员。",
                  "Reviewers are read-only; policy changes and publishing are limited to administrators."
                )}
              </p>
            )}
          </div>
          <div className="policyHistory">
            {data.policies.map((policy) => (
              <span key={policy.version} className={policy.active ? "active" : ""}>
                <b>{policy.version}</b>
                {policy.createdBy} · {formatAdminRelativeTime(policy.createdAt)}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {tab === "audit" && activePolicy ? (
        <div className="auditTimeline">
          {(data.operations?.audit ?? []).map((event) => (
            <article key={event.id}>
              <time>{formatAdminRelativeTime(event.at)}</time>
              <div>
                <strong>{event.action}</strong>
                <span>
                  {event.actor} · {event.targetType} · {event.targetId}
                </span>
                <p>{auditDetail(event)}</p>
              </div>
            </article>
          ))}
          {!data.operations?.audit.length ? <p className="testerConversationEmpty">尚未记录治理或发布变更。</p> : null}
        </div>
      ) : null}
    </section>
  );
}
