// Prepaid top-ups: QR-code orders at a payment provider, and crediting them
// once the provider has verified the payment. creditPaidOrder is the only way
// money enters a balance.

import { randomBytes } from "node:crypto";
import { createLogger } from "../logger";
import { ORDER_LIFETIME_MS, packById } from "./billing";
import { cloudPaymentProvider, cloudPublicUrl, now } from "./context";
import { countCloud } from "./counters";
import type { PaidOrder, PaymentProvider } from "./payments";
import {
  closePendingOrder,
  creditOrder,
  insertOrder,
  openOrderCount,
  orderById,
  type CreditOutcome,
  type OrderRow
} from "./store";
import type { Result } from "./customers";

const log = createLogger("cloud-pay");

const ORDER_ID = /^[A-Za-z0-9]{6,32}$/;
const MAX_TXN_ID_LENGTH = 128;
// Unpaid, unexpired orders one customer may hold at once, so nobody can flood the providers.
const MAX_OPEN_ORDERS = 5;

export type TopupOrder = { orderId: string; provider: string; amountFen: number; qrCode: string; expiresAt: number };
export type CreditResult = CreditOutcome | "invalid";

/** True for an id this relay could have issued. */
export function validOrderId(value: unknown): value is string {
  return typeof value === "string" && ORDER_ID.test(value);
}

/** `mc` + UTC yyyyMMddHHmmss + 16 random hex: 32 alphanumeric characters (WeChat allows 6–32). */
function newOrderId(at: number): string {
  const stamp = new Date(at).toISOString().replace(/\D/g, "").slice(0, 14);
  return `mc${stamp}${randomBytes(8).toString("hex")}`;
}

/** Whether an outcome means the provider's notification was handled (so it stops retrying). */
export function creditAccepted(outcome: CreditResult): boolean {
  return outcome === "credited" || outcome === "duplicate";
}

/**
 * Credits a provider-verified payment, once. In one transaction it checks the
 * order exists, belongs to this provider and was paid in full, then marks it
 * paid and adds the `topup` ledger entry. A repeat for the same order is a
 * no-op ("duplicate"), which callers treat as success.
 */
export function creditPaidOrder(paid: PaidOrder, provider: string): CreditResult {
  const shapeOk =
    paid !== null &&
    typeof paid === "object" &&
    validOrderId(paid.orderId) &&
    typeof paid.providerTxnId === "string" &&
    paid.providerTxnId.length > 0 &&
    paid.providerTxnId.length <= MAX_TXN_ID_LENGTH &&
    Number.isSafeInteger(paid.amountFen) &&
    paid.amountFen > 0;
  if (!shapeOk) {
    countCloud("max_cloud_topups_refused_total");
    log.warn("paid order refused", { provider, reason: "invalid" });
    return "invalid";
  }
  const outcome = creditOrder(paid, provider, now());
  const fields = { provider, orderId: paid.orderId, amountFen: paid.amountFen };
  if (outcome === "credited") {
    countCloud("max_cloud_topups_credited_total");
    log.info("top-up credited", fields);
  } else if (outcome !== "duplicate") {
    countCloud("max_cloud_topups_refused_total");
    log.warn("paid order refused", { ...fields, reason: outcome });
  }
  return outcome;
}

export async function createTopup(customerId: string, body: Record<string, unknown>): Promise<Result<TopupOrder>> {
  const pack = packById(body.pack);
  if (!pack) return { ok: false, status: 400, error: "Unknown pack." };
  const provider = typeof body.provider === "string" ? cloudPaymentProvider(body.provider) : undefined;
  if (!provider) return { ok: false, status: 400, error: "This payment method is not available." };
  const publicUrl = cloudPublicUrl();
  if (!publicUrl && provider.id !== "test") {
    log.warn("top-up refused: CLOUD_PUBLIC_URL is not set to an http(s) URL", { provider: provider.id });
    return { ok: false, status: 503, error: "Top-ups are not available right now." };
  }
  const at = now();
  if (openOrderCount(customerId, at) >= MAX_OPEN_ORDERS) {
    return { ok: false, status: 429, error: "Too many unpaid top-ups. Pay or wait for one to expire." };
  }
  const order: OrderRow = {
    id: newOrderId(at),
    customer_id: customerId,
    provider: provider.id,
    pack: pack.id,
    amount_fen: pack.fen,
    status: "pending",
    provider_txn_id: null,
    created_at: at,
    paid_at: null,
    expires_at: at + ORDER_LIFETIME_MS
  };
  // Stored before the provider hears of it, so no payable order is ever unknown here.
  insertOrder(order);
  let qrCode: string;
  try {
    ({ qrCode } = await provider.createQrOrder({
      orderId: order.id,
      amountFen: order.amount_fen,
      description: "Max Cloud top-up",
      notifyUrl: `${publicUrl ?? ""}/cloud/pay/${provider.id}/notify`,
      expiresAt: order.expires_at
    }));
    if (typeof qrCode !== "string" || !qrCode) throw new Error("the provider returned no QR code");
  } catch (error) {
    closePendingOrder(order.id);
    log.warn("top-up order not created", {
      provider: provider.id,
      orderId: order.id,
      message: error instanceof Error ? error.message : String(error)
    });
    return { ok: false, status: 502, error: "The payment provider did not answer. Try again." };
  }
  return {
    ok: true,
    value: {
      orderId: order.id,
      provider: provider.id,
      amountFen: order.amount_fen,
      qrCode,
      expiresAt: order.expires_at
    }
  };
}

/** Closes an expired pending order here and, best effort, at its provider. */
function closeIfExpired(order: OrderRow, provider: PaymentProvider | undefined): void {
  if (order.status !== "pending" || order.expires_at > now()) return;
  if (!closePendingOrder(order.id)) return;
  provider?.closeOrder(order.id).catch((error: unknown) => {
    log.warn("closing an expired order at the provider failed", {
      provider: order.provider,
      orderId: order.id,
      message: error instanceof Error ? error.message : String(error)
    });
  });
}

/** An order as read now: expired pending orders are closed on the way. */
export function readOrder(orderId: string): OrderRow | undefined {
  const order = orderById(orderId);
  if (!order) return undefined;
  closeIfExpired(order, cloudPaymentProvider(order.provider));
  return orderById(orderId);
}

/**
 * The status of one of the customer's orders. A pending order is checked with
 * the provider first (the polling fallback for a lost notification), also
 * once it has expired, so a payment made at the last second is still credited.
 */
const ORDER_QUERY_INTERVAL_MS = 3_000;
const lastOrderQuery = new Map<string, number>();

export async function topupStatus(
  customerId: string,
  orderId: string
): Promise<Result<{ status: OrderRow["status"] }>> {
  const order = validOrderId(orderId) ? orderById(orderId) : undefined;
  if (!order || order.customer_id !== customerId) return { ok: false, status: 404, error: "Order not found." };
  const provider = cloudPaymentProvider(order.provider);
  // At most one provider query per order every 3 s, however often the
  // console (or anyone with a login) polls: the merchant's API is shared.
  const lastQuery = lastOrderQuery.get(order.id) ?? 0;
  if (order.status === "pending" && provider && now() - lastQuery >= ORDER_QUERY_INTERVAL_MS) {
    lastOrderQuery.set(order.id, now());
    if (lastOrderQuery.size > 10_000) lastOrderQuery.clear();
    try {
      const paid = await provider.queryOrder(order.id);
      if (paid && paid.orderId === order.id) creditPaidOrder(paid, provider.id);
    } catch (error) {
      log.warn("order query failed", {
        provider: provider.id,
        orderId: order.id,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  const current = orderById(order.id) ?? order;
  closeIfExpired(current, provider);
  return { ok: true, value: { status: orderById(order.id)?.status ?? current.status } };
}
