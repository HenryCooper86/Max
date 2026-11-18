// Development-only payment provider: the "QR code" is a URL to POST /cloud/pay/test/:orderId, which marks the order
// paid. Enabled only with CLOUD_PAYMENTS_TEST=on outside production. Orders live in memory.
import type { PaidOrder, PaymentProvider, QrOrder } from "./types";
import type { Env } from "./util";

/** At most this many test orders are remembered; the oldest are forgotten first. */
const MAX_ORDERS = 1000;

type TestOrder = { amountFen: number; paid: boolean };

const orders = new Map<string, TestOrder>();

function enabled(env: Env): boolean {
  return env.CLOUD_PAYMENTS_TEST === "on" && env.NODE_ENV !== "production";
}

function paidOrder(orderId: string): PaidOrder {
  const order = orders.get(orderId);
  return { orderId, providerTxnId: `test_${orderId}`, amountFen: order?.amountFen ?? 0 };
}

export type TestProviderOptions = {
  /** Read on every call. Defaults to process.env. */
  env?: Env;
};

export function createTestProvider(options: TestProviderOptions = {}): PaymentProvider {
  const env = options.env ?? process.env;
  return {
    id: "test",

    configured() {
      return enabled(env);
    },

    async createQrOrder(order: QrOrder) {
      if (!enabled(env)) throw new Error("The test payment provider is off");
      if (!Number.isSafeInteger(order.amountFen) || order.amountFen <= 0) throw new Error("Invalid order amount");
      orders.delete(order.orderId);
      orders.set(order.orderId, { amountFen: order.amountFen, paid: false });
      while (orders.size > MAX_ORDERS) {
        const oldest = orders.keys().next().value;
        if (oldest === undefined) break;
        orders.delete(oldest);
      }
      const base = (env.CLOUD_PUBLIC_URL?.trim() || "http://localhost:8787").replace(/\/+$/, "");
      return { qrCode: `${base}/cloud/pay/test/${encodeURIComponent(order.orderId)}` };
    },

    async parseNotification() {
      return null; // The test provider never sends notifications.
    },

    notificationAnswer(accepted: boolean) {
      return { status: accepted ? 200 : 400, contentType: "text/plain", body: accepted ? "ok" : "invalid" };
    },

    async queryOrder(orderId: string) {
      if (!enabled(env)) return null;
      return orders.get(orderId)?.paid ? paidOrder(orderId) : null;
    },

    async closeOrder(orderId: string) {
      if (orders.get(orderId)?.paid === false) orders.delete(orderId);
    }
  };
}

/**
 * Marks a test order paid (for POST /cloud/pay/test/:orderId). Returns the paid order, or null when the test
 * provider is off, the order is unknown, or it was closed.
 */
export function markTestOrderPaid(orderId: string, env: Env = process.env): PaidOrder | null {
  if (!enabled(env)) return null;
  const order = orders.get(orderId);
  if (!order) return null;
  order.paid = true;
  return paidOrder(orderId);
}
