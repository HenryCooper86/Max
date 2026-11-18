import type { LedgerEntry, Usage } from "./api";
import { formatMinutes, formatYuan, wholeMinutes } from "./format";
import { useSay } from "./hooks";

export function UsageSection({ usage }: { usage: Usage | null }) {
  const say = useSay();
  return (
    <section className="cxSection" id="usage" aria-labelledby="cx-usage">
      <h2 id="cx-usage">{say("本月用量", "Usage this month")}</h2>
      {!usage ? (
        <p className="cxMuted">…</p>
      ) : (
        <>
          <dl className="cxStats">
            <div>
              <dt>{say("通话分钟", "Minutes")}</dt>
              <dd>{formatMinutes(usage.minutes)}</dd>
            </div>
            <div>
              <dt>{say("已用免费分钟", "Free minutes used")}</dt>
              <dd>{wholeMinutes(usage.freeSecondsUsed).toLocaleString("en-US")}</dd>
            </div>
            <div>
              <dt>{say("已扣费", "Charged")}</dt>
              <dd>{formatYuan(usage.chargedFen)}</dd>
            </div>
          </dl>
          {usage.projects.length === 0 ? (
            <p className="cxMuted">{say("本月还没有通话。", "No calls yet this month.")}</p>
          ) : (
            <div className="cxTableWrap">
              <table className="cxTable">
                <caption className="visuallyHidden">{say("按项目的用量", "Usage by project")}</caption>
                <thead>
                  <tr>
                    <th scope="col">{say("项目", "Project")}</th>
                    <th scope="col">{say("分钟", "Minutes")}</th>
                    <th scope="col">{say("扣费", "Charged")}</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.projects.map((row) => (
                    <tr key={row.projectId}>
                      <th scope="row">{row.name}</th>
                      <td>{formatMinutes(row.seconds / 60)}</td>
                      <td>{formatYuan(row.chargedFen)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** One ledger line as words: what happened and the money. */
function describeEntry(entry: LedgerEntry, say: (zh: string, en: string) => string): string {
  if (entry.kind === "topup") return say("充值", "Top-up");
  if (entry.kind === "usage") {
    return say(`通话 ${formatMinutes(entry.seconds / 60)} 分钟`, `Call, ${formatMinutes(entry.seconds / 60)} min`);
  }
  return say("调整", "Adjustment");
}

export function ActivitySection({ entries }: { entries: LedgerEntry[] | null }) {
  const say = useSay();
  const sorted = entries ? [...entries].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id) : null;
  return (
    <section className="cxSection" id="activity" aria-labelledby="cx-activity">
      <h2 id="cx-activity">{say("记录", "Activity")}</h2>
      {!sorted ? (
        <p className="cxMuted">…</p>
      ) : sorted.length === 0 ? (
        <p className="cxMuted">{say("还没有记录。", "Nothing here yet.")}</p>
      ) : (
        <ul className="cxLedger">
          {sorted.map((entry) => (
            <li key={entry.id}>
              <span>
                {describeEntry(entry, say)}
                <small>{new Date(entry.createdAt).toLocaleString()}</small>
              </span>
              <strong className={entry.amountFen > 0 ? "plus" : undefined}>
                {entry.amountFen > 0 ? "+" : ""}
                {formatYuan(entry.amountFen)}
              </strong>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
