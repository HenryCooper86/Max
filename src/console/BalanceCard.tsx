import type { Me } from "./api";
import { formatYuan, wholeMinutes } from "./format";
import { useSay } from "./hooks";

export function BalanceCard({ me, onTopUp }: { me: Me | null; onTopUp: () => void }) {
  const say = useSay();
  return (
    <section className="cxCard cxBalance" aria-labelledby="cx-balance">
      <div>
        <h2 id="cx-balance">{say("余额", "Balance")}</h2>
        <p className="cxBig" aria-busy={!me}>
          {me ? formatYuan(me.balance.fen) : "…"}
        </p>
        <p className="cxMuted">
          {me
            ? say(
                `本月还剩 ${wholeMinutes(me.balance.freeSecondsLeft).toLocaleString("en-US")} 免费分钟`,
                `${wholeMinutes(me.balance.freeSecondsLeft).toLocaleString("en-US")} free minutes left this month`
              )
            : ""}
        </p>
      </div>
      <button className="siteButton" type="button" onClick={onTopUp}>
        {say("充值", "Top up")}
      </button>
    </section>
  );
}
