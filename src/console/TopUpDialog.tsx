import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";
import type { Pack, Packs, Provider, TopupOrder } from "./api";
import { CONTACT_EMAIL, contactUrl } from "../lib/pricing";
import { formatYuan } from "./format";
import { useSay, type Session } from "./hooks";
import { shouldKeepPolling, toMillis, TOPUP_POLL_MS } from "./poll";

type Phase = "pending" | "paid" | "closed";

function providerLabel(provider: Provider, say: (zh: string, en: string) => string): string {
  return provider === "wechat"
    ? "微信支付 WeChat Pay"
    : provider === "alipay"
      ? "支付宝 Alipay"
      : say("测试支付", "Test payment");
}

function QrImage({ value, label }: { value: string; label: string }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let active = true;
    QRCode.toDataURL(value, { errorCorrectionLevel: "M", margin: 1, width: 240 })
      .then((url) => {
        if (active) setSrc(url);
      })
      .catch(() => {
        if (active) setSrc("");
      });
    return () => {
      active = false;
    };
  }, [value]);
  return src ? (
    <img className="cxQr" src={src} width={240} height={240} alt={label} />
  ) : (
    <div className="cxQr" aria-hidden="true" />
  );
}

/** Pick a pack and a way to pay, show the QR code, and wait for the money. */
export function TopUpDialog({
  session,
  onClose,
  onPaid
}: {
  session: Session;
  onClose: () => void;
  onPaid: () => void;
}) {
  const say = useSay();
  const { api, token, fail } = session;
  const [options, setOptions] = useState<Packs | null>(null);
  const [pack, setPack] = useState<string>("");
  const [provider, setProvider] = useState<Provider | "">("");
  const [order, setOrder] = useState<TopupOrder | null>(null);
  const [phase, setPhase] = useState<Phase>("pending");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const paidCallback = useRef(onPaid);
  paidCallback.current = onPaid;

  useEffect(() => {
    let active = true;
    api
      .packs(token)
      .then((result) => {
        if (!active) return;
        setOptions(result);
        setPack(result.packs[0]?.id ?? "");
        setProvider(result.providers[0] ?? "");
      })
      .catch((caught) => {
        if (active) setError(fail(caught));
      });
    return () => {
      active = false;
    };
  }, [api, token, fail]);

  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Ask about the order every two seconds until it is paid, closed, past its
  // expiry, or this dialog goes away.
  useEffect(() => {
    if (!order) return;
    let stopped = false;
    let timer = 0;
    const expiresAt = toMillis(order.expiresAt);
    const tick = async () => {
      let status: Phase = "pending";
      try {
        status = (await api.topupStatus(token, order.orderId)).status;
      } catch (caught) {
        fail(caught);
      }
      if (stopped) return;
      if (status === "paid") {
        setPhase("paid");
        paidCallback.current();
        return;
      }
      if (!shouldKeepPolling(status, expiresAt, Date.now())) {
        setPhase("closed");
        return;
      }
      timer = window.setTimeout(() => void tick(), TOPUP_POLL_MS);
    };
    timer = window.setTimeout(() => void tick(), TOPUP_POLL_MS);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [order, api, token, fail]);

  const start = async () => {
    if (!pack || !provider) return;
    setBusy(true);
    setError("");
    try {
      setPhase("pending");
      setOrder(await api.createTopup(token, pack, provider));
    } catch (caught) {
      setError(fail(caught));
    } finally {
      setBusy(false);
    }
  };

  const packLabel = (item: Pack) => formatYuan(item.fen);

  return (
    <div className="cxScrim" onClick={onClose}>
      <div
        className="cxDialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cx-topup-title"
        tabIndex={-1}
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="cxRow spread">
          <h2 id="cx-topup-title">{say("充值", "Top up")}</h2>
          <button type="button" className="siteButton quiet small" onClick={onClose}>
            {say("关闭", "Close")}
          </button>
        </div>

        {!order ? (
          <div>
            {!options ? (
              <p className="cxMuted" aria-live="polite">
                {error || "…"}
              </p>
            ) : options.providers.length === 0 ? (
              <ManualTopUp />
            ) : (
              <>
                <fieldset className="cxChoices">
                  <legend>{say("选择金额", "Choose an amount")}</legend>
                  {options.packs.map((item) => (
                    <label key={item.id} className={pack === item.id ? "on" : undefined}>
                      <input type="radio" name="pack" checked={pack === item.id} onChange={() => setPack(item.id)} />
                      {packLabel(item)}
                    </label>
                  ))}
                </fieldset>
                <fieldset className="cxChoices">
                  <legend>{say("支付方式", "Pay with")}</legend>
                  {options.providers.map((item) => (
                    <label key={item} className={provider === item ? "on" : undefined}>
                      <input
                        type="radio"
                        name="provider"
                        checked={provider === item}
                        onChange={() => setProvider(item)}
                      />
                      {providerLabel(item, say)}
                    </label>
                  ))}
                </fieldset>
                <p className="cxError" aria-live="polite">
                  {error}
                </p>
                <button
                  className="siteButton"
                  type="button"
                  disabled={busy || !pack || !provider}
                  onClick={() => void start()}
                >
                  {say("继续", "Continue")}
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="cxPay" aria-live="polite">
            {phase === "paid" ? (
              <p className="cxOk">
                {say(`已支付，到账 ${formatYuan(order.amountFen)}`, `Paid — ${formatYuan(order.amountFen)} added`)}
              </p>
            ) : phase === "closed" ? (
              <>
                <p className="cxWarn">
                  {say("这次支付已过期，请重新发起。", "This payment expired. Start a new one.")}
                </p>
                <button
                  className="siteButton"
                  type="button"
                  onClick={() => {
                    setOrder(null);
                    setPhase("pending");
                  }}
                >
                  {say("重新开始", "Start over")}
                </button>
              </>
            ) : (
              <>
                <p className="cxBig">{formatYuan(order.amountFen)}</p>
                <QrImage value={order.qrCode} label={say("付款二维码", "Payment QR code")} />
                <p>
                  {order.provider === "alipay"
                    ? say("用支付宝扫码", "Scan with Alipay")
                    : order.provider === "wechat"
                      ? say("用微信扫码", "Scan with WeChat")
                      : say("测试支付", "Test payment")}
                </p>
                {order.provider === "test" ? (
                  <a className="siteTextLink" href={order.qrCode} target="_blank" rel="noreferrer noopener">
                    {say("打开测试支付页面", "Open test payment page")}
                  </a>
                ) : null}
                <p className="cxMuted">{say("付款后这里会自动更新。", "This updates by itself once you've paid.")}</p>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Shown while online payment is off: balance is added by hand after payment. */
function ManualTopUp() {
  const say = useSay();
  return (
    <div className="cxManual">
      <p>
        {say(
          `在线支付暂未开放。需要增加余额时，请发邮件到 ${CONTACT_EMAIL}，告诉我们你的账户邮箱和金额；我们会发送付款方式，收款后为你加上余额。`,
          `Online payment isn't available yet. To add balance, email ${CONTACT_EMAIL} with your account email and the amount: we'll send payment details and add the balance once it arrives.`
        )}
      </p>
      <p className="cxMuted">
        {say("每月前 1,000 分钟免费，无需充值。", "Your first 1,000 minutes every month are free; no top-up needed.")}
      </p>
      <a className="siteButton" href={contactUrl("Max Cloud balance")}>
        {say("发送邮件", "Email us")}
      </a>
    </div>
  );
}
