import { useEffect, useState } from "react";
import { useLanguage } from "../../components/LanguageToggle";
import { type ProjectUsage } from "../api";
import { formatMinutes } from "../format";
import { useSay } from "../hooks";
import type { StudioTabProps } from "./types";

/** How far back the month list goes at most. */
const MAX_USAGE_MONTHS = 24;
/** What the report calls the sessions that named no user. */
const ANONYMOUS = "anonymous";

/** "2026-11" for a time: the UTC calendar month Max Cloud books usage to. */
const monthOf = (at: number) => new Date(at).toISOString().slice(0, 7);

/** The months a project's usage can be shown for, the current one first: back to the month it was created in, at most 24. */
export function usageMonths(createdAt: number, at: number): string[] {
  const first = monthOf(createdAt);
  const months: string[] = [];
  // On the first of the month: a 31st stepped back into a 30-day month would land in the month after it.
  const date = new Date(at);
  date.setUTCDate(1);
  while (months.length < MAX_USAGE_MONTHS) {
    const month = monthOf(date.getTime());
    months.push(month);
    if (month === first) break;
    date.setUTCMonth(date.getUTCMonth() - 1);
  }
  return months;
}

/** A month in words: "2026年11月" in Chinese, "November 2026" in English. */
export function monthLabel(month: string, language: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString(language, {
    year: "numeric",
    month: "long",
    timeZone: "UTC"
  });
}

/** Studio → Usage: the project's minutes per user for a month, to bill by and to see who is near the per-user limit. */
export function UsageTab({ session, project }: Pick<StudioTabProps, "session" | "project">) {
  const say = useSay();
  const { language } = useLanguage();
  const { api, token, fail } = session;
  const months = usageMonths(project.createdAt, Date.now());
  const [month, setMonth] = useState(months[0]!);
  const [usage, setUsage] = useState<ProjectUsage | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    api.projectUsage(token, project.id, month).then(
      (result) => {
        if (!active) return;
        setUsage(result);
        setError("");
      },
      (caught: unknown) => {
        if (active) setError(fail(caught));
      }
    );
    return () => {
      active = false;
    };
  }, [api, token, fail, project.id, month, attempt]);

  const limit = usage?.limitMinutes ?? 0;
  const namedUsers = usage?.users.filter((user) => user.userId !== ANONYMOUS).length ?? 0;
  const selectId = `cxs-${project.id}-usage-month`;
  return (
    <div className="cxsPanel">
      <label className="cxField" htmlFor={selectId}>
        <span>{say("月份", "Month")}</span>
        <select
          id={selectId}
          value={month}
          onChange={(event) => {
            setUsage(null);
            setError("");
            setMonth(event.target.value);
          }}
        >
          {months.map((option) => (
            <option key={option} value={option}>
              {monthLabel(option, language)}
            </option>
          ))}
        </select>
        <small>
          {say(
            "每个对话的分钟数按会话令牌里的 userId 记到对应用户名下。",
            "Each conversation's minutes go to the userId on its session token."
          )}
        </small>
      </label>
      {error ? (
        <div role="alert">
          <p className="cxError">{error}</p>
          <button
            type="button"
            className="siteButton secondary small"
            onClick={() => {
              setUsage(null);
              setAttempt((count) => count + 1);
            }}
          >
            {say("重试", "Retry")}
          </button>
        </div>
      ) : null}
      {!usage ? (
        error ? null : (
          <p className="cxMuted">…</p>
        )
      ) : (
        <>
          <dl className="cxStats">
            <div>
              <dt>{say("分钟", "Minutes")}</dt>
              <dd>{formatMinutes(usage.totals.minutes)}</dd>
            </div>
            <div>
              <dt>{say("对话", "Conversations")}</dt>
              <dd>{usage.totals.sessions.toLocaleString("en-US")}</dd>
            </div>
            <div>
              <dt>{say("用户", "Users")}</dt>
              <dd>{usage.userCount.toLocaleString("en-US")}</dd>
            </div>
          </dl>
          {usage.users.length === 0 ? (
            <p className="cxMuted">{say("这个月还没有通话。", "No calls yet this month.")}</p>
          ) : (
            <div className="cxTableWrap">
              <table className="cxTable">
                <caption className="visuallyHidden">{say("按用户的用量", "Usage by user")}</caption>
                <thead>
                  <tr>
                    <th scope="col">{say("用户", "User")}</th>
                    <th scope="col">{say("对话", "Conversations")}</th>
                    <th scope="col">{say("分钟", "Minutes")}</th>
                    {limit > 0 ? <th scope="col">{say("占每月上限", "Of monthly limit")}</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {usage.users.map((user) => (
                    <tr key={user.userId}>
                      <th scope="row">{user.userId === ANONYMOUS ? say("没有用户 ID", "No user ID") : user.userId}</th>
                      <td>{user.sessions.toLocaleString("en-US")}</td>
                      <td>{formatMinutes(user.minutes)}</td>
                      {limit > 0 ? <td>{Math.floor((user.seconds / (limit * 60)) * 100)}%</td> : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {usage.userCount > namedUsers ? (
            <p className="cxMuted">
              {say(
                `只列出用量最多的 ${namedUsers} 位用户，这个月共有 ${usage.userCount.toLocaleString("en-US")} 位。`,
                `Only the ${namedUsers} heaviest users are listed; the month has ${usage.userCount.toLocaleString("en-US")}.`
              )}
            </p>
          ) : null}
          {limit > 0 ? (
            <p className="cxMuted">
              {say(
                `每月上限为每个用户 ${limit.toLocaleString("en-US")} 分钟，在“设置”里修改。没有用户 ID 的对话（网站嵌入、Studio 测试）不计入任何用户的上限。`,
                `The monthly limit is ${limit.toLocaleString("en-US")} minutes per user, set in Settings. Conversations without a user ID (website embeds, Studio tests) do not count towards any user's limit.`
              )}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
