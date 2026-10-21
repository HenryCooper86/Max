import { useMemo } from "react";
import type { TestingQuality } from "../../../shared/testing";
import type { AuthUser } from "../../lib/auth";
import { useLanguage } from "../LanguageToggle";
import { localized } from "../../lib/i18n";
import { formatDuration } from "../../lib/utils";
import { formatAdminRelativeTime } from "./admin-model";
import {
  testingPlatformLabel,
  testingQualityLabel,
  testingSessionResult,
  testingSessionTitle
} from "./testing-presentation";
import type { AdminTestingData } from "./useAdminTestingData";

type Props = {
  user: AuthUser;
  data: AdminTestingData;
  onOpenSessions: (filters?: Record<string, string | null>) => void;
  onOpenPlans: () => void;
  onStartTesting: () => void;
};

const RECENT_SESSION_LIMIT = 6;
const RESULT_BUCKETS: TestingQuality[] = ["pass", "watch", "fail"];

export function TestingOverview({ user, data, onOpenSessions, onOpenPlans, onStartTesting }: Props) {
  const { language } = useLanguage();
  const name = user.displayName?.trim() || user.username;

  // The session list is the most recently loaded page for this account's scope
  // (a tester sees only their own sessions). Counts below describe exactly
  // these records — never an all-history total dressed up as one.
  const sessions = useMemo(() => [...data.sessions].sort((a, b) => b.endedAt - a.endedAt), [data.sessions]);
  const recent = useMemo(() => sessions.slice(0, RECENT_SESSION_LIMIT), [sessions]);
  const counts = useMemo(() => {
    const next: Record<TestingQuality | "incomplete", number> = { pass: 0, watch: 0, fail: 0, incomplete: 0 };
    for (const session of recent) {
      if (session.validity?.status === "invalid") next.incomplete += 1;
      else next[session.quality] += 1;
    }
    return next;
  }, [recent]);
  const remaining = Math.max(0, data.sessionTotal - recent.length);
  const loading = data.status === "loading" && sessions.length === 0;

  return (
    <section
      className="adminSectionCard testingOverview"
      aria-label={localized(language, "测试概览", "Testing overview")}
    >
      <div className="testingWelcome">
        <div className="testingWelcomeCopy">
          <h2>{localized(language, `欢迎回来，${name}`, `Welcome back, ${name}`)}</h2>
          <p>
            {localized(
              language,
              "这里只显示你需要看的信息：开始一次语音测试、查看测试计划，或回顾最近的测试记录。",
              "Only what you need: start a voice test, check your test plans, or look back at recent test records."
            )}
          </p>
        </div>
        <div className="testingWelcomeActions">
          <button type="button" className="primary" onClick={onStartTesting}>
            {localized(language, "开始语音测试", "Start voice testing")}
          </button>
          <button type="button" onClick={onOpenPlans}>
            {localized(language, "查看测试计划", "View test plans")}
          </button>
          <button type="button" onClick={() => onOpenSessions()}>
            {localized(language, "查看测试记录", "Browse test results")}
          </button>
        </div>
      </div>

      {data.status === "error" ? (
        <p className="testingStatusNote" role="status">
          {localized(
            language,
            "测试记录暂时无法加载，请稍后重试。",
            "Test records could not be loaded right now. Please try again shortly."
          )}
        </p>
      ) : null}
      {data.status === "stale" ? (
        <p className="testingStatusNote" role="status">
          {localized(language, "显示的可能是较早的记录。", "What you see may be slightly out of date.")}
        </p>
      ) : null}

      <div className="testingResultSummary">
        <div className="testingResultHead">
          <h3>{localized(language, "最近测试结果", "Recent test results")}</h3>
          {recent.length ? (
            <span className="testingResultScope">
              {localized(
                language,
                `最近已加载的 ${recent.length} 条记录`,
                `The ${recent.length} most recently loaded record${recent.length === 1 ? "" : "s"}`
              )}
            </span>
          ) : null}
        </div>
        {loading ? (
          <p className="testingEmpty">{localized(language, "正在加载测试记录…", "Loading test records…")}</p>
        ) : recent.length ? (
          <>
            <div className="testingQualityRow">
              {RESULT_BUCKETS.map((bucket) => (
                <button
                  type="button"
                  className={`testingQualityCard ${bucket === "pass" ? "good" : bucket === "watch" ? "warn" : "alert"}`}
                  key={bucket}
                  onClick={() => onOpenSessions({ quality: bucket })}
                >
                  <span>{testingQualityLabel(bucket, language)}</span>
                  <strong>{counts[bucket]}</strong>
                </button>
              ))}
              {counts.incomplete ? (
                <button
                  type="button"
                  className="testingQualityCard warn"
                  onClick={() => onOpenSessions({ quality: "incomplete" })}
                >
                  <span>{localized(language, "记录不完整", "Incomplete recording")}</span>
                  <strong>{counts.incomplete}</strong>
                </button>
              ) : null}
            </div>
            {remaining > 0 ? (
              <p className="testingResultScope">
                {localized(
                  language,
                  `还有 ${remaining} 条更早的记录，可在测试记录中查看。`,
                  `${remaining} earlier record${remaining === 1 ? "" : "s"} available in test results.`
                )}
              </p>
            ) : null}
          </>
        ) : (
          <p className="testingEmpty">
            {localized(
              language,
              "还没有测试记录。完成第一次语音测试后，结果会显示在这里。",
              "No test records yet. Results will appear here after your first voice test."
            )}
          </p>
        )}
      </div>

      <div className="testingRecent">
        <div className="testingResultHead">
          <h3>{localized(language, "最近的测试", "Recent tests")}</h3>
          {recent.length ? (
            <span className="testingResultScope">
              {localized(language, `显示最近 ${recent.length} 条`, `Showing the ${recent.length} latest`)}
            </span>
          ) : null}
        </div>
        {recent.length ? (
          <ul className="testingSessionList">
            {recent.map((session) => {
              const result = testingSessionResult(session, language);
              const title = testingSessionTitle(session, language);
              const platform = testingPlatformLabel(session.platform, language);
              const when = formatAdminRelativeTime(session.endedAt, language);
              const duration = formatDuration(session.durationMs);
              return (
                <li key={session.sessionId}>
                  <button
                    type="button"
                    className="testingSessionRow"
                    aria-label={`${title}，${result.label}，${platform}，${duration}，${when}`}
                    onClick={() => onOpenSessions({ session: session.sessionId })}
                  >
                    <span className="testingSessionRowTop">
                      <strong>{title}</strong>
                      <span className={`testingQualityChip ${result.tone}`}>{result.label}</span>
                    </span>
                    {result.reasons.length ? <small>{result.reasons.join("；")}</small> : null}
                    <small>
                      {platform} · {duration} · {when}
                    </small>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : !loading ? (
          <p className="testingEmpty">
            {localized(
              language,
              "开始一次语音测试后，最近的对话会出现在这里。",
              "Start a voice test and your recent conversations will appear here."
            )}
          </p>
        ) : null}
      </div>
    </section>
  );
}
