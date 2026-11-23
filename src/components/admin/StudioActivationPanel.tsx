import type { StudioActivation } from "../../../shared/cloud-studio";
import { localized, type Language } from "../../lib/i18n";

function formatElapsed(ms: number, language: Language): string {
  const units = [
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
    ["second", 1_000]
  ] as const;
  const [unit, divisor] = units.find(([, duration]) => ms >= duration) ?? units[3];
  return new Intl.NumberFormat(language, { style: "unit", unit, unitDisplay: "long", maximumFractionDigits: 1 }).format(
    ms / divisor
  );
}

export function StudioActivationPanel({ metrics, language }: { metrics: StudioActivation | null; language: Language }) {
  const say = (zh: string, en: string) => localized(language, zh, en);
  return (
    <section className="decisionPanel adminSectionCard adminSectionInset" aria-labelledby="studio-activation-heading">
      <h3 id="studio-activation-heading">{say("Studio 项目启用情况", "Studio activation")}</h3>
      {metrics === null ? (
        <p>{say("暂时无法加载项目启用数据。", "Studio activation data is temporarily unavailable.")}</p>
      ) : metrics.newProjects === 0 ? (
        <p>
          {say(
            `过去 ${metrics.windowDays} 天没有新建项目。`,
            `No projects were created in the last ${metrics.windowDays} days.`
          )}
        </p>
      ) : (
        <>
          <p>
            {say(
              `过去 ${metrics.windowDays} 天创建了 ${metrics.newProjects} 个项目，其中 ${metrics.activatedProjects} 个已完成首次成功的网站对话。`,
              `Among projects created in the last ${metrics.windowDays} days, ${metrics.activatedProjects} of ${metrics.newProjects} reached their first successful website conversation.`
            )}
          </p>
          <div className="adminAccountSummary">
            <span>
              <b>
                {new Intl.NumberFormat(language, { style: "percent", maximumFractionDigits: 1 }).format(
                  metrics.activatedProjects / metrics.newProjects
                )}
              </b>
              {say("已完成首次网站对话的项目占比", "Reached a first website conversation")}
            </span>
            <span>
              <b>{metrics.medianTimeMs === null ? "—" : formatElapsed(metrics.medianTimeMs, language)}</b>
              {say("从创建到首次成功对话的中位时间", "Median time from creation to first success")}
            </span>
          </div>
        </>
      )}
    </section>
  );
}
