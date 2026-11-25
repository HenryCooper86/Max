// Prepaid top-ups: QR-code orders at a payment provider, and crediting them
// once the provider has verified the payment. creditPaidOrder is the only way
// money enters a balance. The provider's notification is not relied on alone:
// an unpaid order is also asked of the provider, by the customer's own polling
// and by a sweep every minute, which goes on asking for a day after an order
// is closed as unpaid.

import { randomBytes } from "node:crypto";
import { createLogger } from "../logger";
import { ORDER_LIFETIME_MS, packById } from "./billing";
import { cloudEnabled, cloudPaymentProvider, cloudPaymentProviders, cloudPublicUrl, now } from "./context";
import { countCloud } from "./counters";
import type { PaidOrder, PaymentProvider } from "./payments";
import {
  closePendingOrder,
  creditOrder,
  insertOrder,
  openOrderCount,
  orderById,
  pendingOrders,
  recentlyClosedOrders,
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

/**
 * Asks the provider whether an order was paid, and credits it if the provider
 * says so: at most once per order every ORDER_QUERY_INTERVAL_MS, however many
 * ask (the console polling, the sweep), because the merchant's API is shared.
 * A query that fails is logged, and counts as asked.
 */
async function askProvider(orderId: string, provider: PaymentProvider | undefined): Promise<void> {
  if (!provider || now() - (lastOrderQuery.get(orderId) ?? 0) < ORDER_QUERY_INTERVAL_MS) return;
  lastOrderQuery.set(orderId, now());
  if (lastOrderQuery.size > 10_000) lastOrderQuery.clear();
  try {
    const paid = await provider.queryOrder(orderId);
    if (paid && paid.orderId === orderId) creditPaidOrder(paid, provider.id);
  } catch (error) {
    log.warn("order query failed", {
      provider: provider.id,
      orderId,
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

export async function topupStatus(
  customerId: string,
  orderId: string
): Promise<Result<{ status: OrderRow["status"] }>> {
  const order = validOrderId(orderId) ? orderById(orderId) : undefined;
  if (!order || order.customer_id !== customerId) return { ok: false, status: 404, error: "Order not found." };
  const provider = cloudPaymentProvider(order.provider);
  if (order.status === "pending") await askProvider(order.id, provider);
  const current = orderById(order.id) ?? order;
  closeIfExpired(current, provider);
  return { ok: true, value: { status: orderById(order.id)?.status ?? current.status } };
}

// --- the sweep -------------------------------------------------------------------

/** How often unpaid orders are asked of their provider, whoever is polling for them or not. */
const SWEEP_INTERVAL_MS = 60_000;
/**
 * How long after an order expired the sweep keeps asking about it once it has
 * been closed as unpaid. The answer that got it closed may have failed (the
 * provider was down) or not have caught up with a payment made at the last
 * second, and a payment the provider confirms in this time is still credited.
 * It ends, so that orders nobody paid are not asked about for ever.
 */
const CLOSED_ORDER_GRACE_MS = 24 * 3_600_000;
/**
 * The least time between two queries of an order that was closed as unpaid.
 * Abandoned orders are common, and one that has answered "unpaid" has nothing
 * new to say a minute later: with this, the sweep's batch goes round all of
 * them instead of being spent every minute on the same few.
 */
const CLOSED_ORDER_REASK_INTERVAL_MS = 15 * 60_000;
/**
 * Orders read for one sweep before its SWEEP_BATCH are chosen, pending and
 * closed alike. Closed ones are read the most recently expired first: they are
 * the likeliest to hold a payment the provider confirmed after the order was
 * closed, and with more waiting than this they are the ones to ask about. The
 * oldest had their turn while they were among the newest.
 */
const SWEEP_CANDIDATES = 5_000;
/** Orders one sweep asks about: a trickle beside the traffic the merchant's API already serves, however many wait. */
const SWEEP_BATCH = 20;

/** What the sweep needs of an order to ask its provider about it. */
type UnpaidOrder = Pick<OrderRow, "id" | "provider">;

let sweepTimer: NodeJS.Timeout | undefined;
/** The sweep under way, if any: when it is done, and what tells it to stop between orders. */
let sweeping: { done: Promise<number>; stop: AbortController } | undefined;

/**
 * The orders one sweep asks about. Pending ones come first, the first to
 * expire first: they can still be paid, or have only just expired. What is
 * left of the batch goes to orders closed as unpaid, to the ones asked about
 * longest ago (never asked first, then the most recently expired), so that the
 * batch goes round them all and an order that expired a moment ago is not kept
 * waiting behind the same old ones every minute. One asked about less than
 * CLOSED_ORDER_REASK_INTERVAL_MS ago is not due: it has just answered.
 *
 * An order whose provider is not configured on this relay cannot be asked
 * about. It would never stop being "never asked", and so come first every
 * sweep: it takes no place in the batch. A pending one is still closed once it
 * has expired, as when its customer reads it.
 */
function ordersToSweep(): UnpaidOrder[] {
  const at = now();
  const providers = new Set<string>(cloudPaymentProviders().map((provider) => provider.id));
  const pending = pendingOrders(SWEEP_CANDIDATES);
  const pendingToAsk = pending.filter((order) => providers.has(order.provider)).slice(0, SWEEP_BATCH);
  // A few at a time, like the asked ones: each is a write to the database, made on the relay's own thread.
  const pendingToClose = pending
    .filter((order) => !providers.has(order.provider) && order.expires_at <= at)
    .slice(0, SWEEP_BATCH);
  const room = SWEEP_BATCH - pendingToAsk.length;
  if (room === 0) return [...pendingToAsk, ...pendingToClose];
  const askedAt = (order: { id: string }): number => lastOrderQuery.get(order.id) ?? 0;
  const closed = recentlyClosedOrders(at, CLOSED_ORDER_GRACE_MS, SWEEP_CANDIDATES)
    .filter((order) => providers.has(order.provider) && at - askedAt(order) >= CLOSED_ORDER_REASK_INTERVAL_MS)
    .sort((left, right) => askedAt(left) - askedAt(right) || right.expires_at - left.expires_at);
  return [...pendingToAsk, ...pendingToClose, ...closed.slice(0, room)];
}

/**
 * Asks the provider of each unpaid order whether it was paid, and credits
 * what it confirms, so a payment whose notification was lost is credited by
 * the next sweep or two, whether or not its customer keeps the top-up dialog
 * open.
 * An order past its expiry is asked once and then closed if it is still
 * unpaid, as when its customer reads it, and asked about for
 * CLOSED_ORDER_GRACE_MS more: a query that failed does not get the last word.
 * Which orders a sweep covers is ordersToSweep's; no order is asked about
 * more than once every 3 seconds.
 *
 * Never throws: what fails is logged and left to the next sweep. Returns how
 * many top-ups it credited. Stops between orders once `signal` is aborted.
 */
export async function sweepTopups(signal?: AbortSignal): Promise<number> {
  if (!cloudEnabled()) return 0;
  let orders: UnpaidOrder[];
  try {
    orders = ordersToSweep();
  } catch (error) {
    log.warn("unpaid orders could not be read", { message: error instanceof Error ? error.message : String(error) });
    return 0;
  }
  let credited = 0;
  for (const order of orders) {
    // Told to stop (the relay is shutting down): the rest is the next sweep's.
    if (signal?.aborted) break;
    try {
      const provider = cloudPaymentProvider(order.provider);
      await askProvider(order.id, provider);
      const current = orderById(order.id);
      if (!current) continue;
      closeIfExpired(current, provider);
      if (current.status === "paid") credited += 1;
    } catch (error) {
      log.warn("an unpaid order could not be settled", {
        provider: order.provider,
        orderId: order.id,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  if (credited) log.info("credited top-ups no notification had arrived for", { topups: credited });
  return credited;
}

/**
 * Runs the sweep every SWEEP_INTERVAL_MS until `stopTopupSweep`. At most one
 * sweep runs at a time, so a slow provider cannot stack them up, and the timer
 * does not keep the relay alive.
 */
export function startTopupSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    if (sweeping) return;
    const stop = new AbortController();
    sweeping = { done: sweepTopups(stop.signal), stop };
    void sweeping.done.finally(() => {
      sweeping = undefined;
    });
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}

/**
 * For a relay that is stopping: ends the sweep and waits up to `timeoutMs`
 * for the one under way, which stops at its next order, so that a credit it
 * is in the middle of writing is written. What it did not reach is still
 * pending, and the next start finds it.
 */
export async function stopTopupSweep(timeoutMs: number): Promise<void> {
  clearInterval(sweepTimer);
  sweepTimer = undefined;
  const current = sweeping;
  if (!current) return;
  current.stop.abort();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([current.done, timeout]);
  clearTimeout(timer);
}

// --- settling one order by hand ----------------------------------------------

/** What settling one order by hand came to (settleOrder). */
type SettleResult =
  | { kind: "unknown-order" }
  | { kind: "provider-missing"; order: OrderRow }
  | { kind: "unpaid"; order: OrderRow }
  | { kind: "confirmed"; order: OrderRow; credited: CreditResult };

/**
 * Settles one order by hand (npm run cloud:settle): asks its provider whether
 * it was paid, however long ago it expired, and credits it if it was, by the
 * same way a notification is credited. So it is safe to run twice and beside a
 * notification that arrives later: the order is credited once. For an order
 * the sweep has stopped asking about (closed as unpaid more than
 * CLOSED_ORDER_GRACE_MS after it expired) that the provider's records show as
 * paid. A provider that cannot be asked throws.
 */
export async function settleOrder(orderId: string): Promise<SettleResult> {
  const order = validOrderId(orderId) ? orderById(orderId) : undefined;
  if (!order) return { kind: "unknown-order" };
  if (order.status === "paid") return { kind: "confirmed", credited: "duplicate", order };
  const provider = cloudPaymentProvider(order.provider);
  if (!provider) return { kind: "provider-missing", order };
  const paid = await provider.queryOrder(order.id);
  if (!paid || paid.orderId !== order.id) return { kind: "unpaid", order };
  return { kind: "confirmed", order, credited: creditPaidOrder(paid, provider.id) };
}
