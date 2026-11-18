/** One QR-code payment the customer is about to scan. Amounts are in fen (¥0.01). */
export type QrOrder = { orderId: string; amountFen: number; description: string; notifyUrl: string; expiresAt: number };

/** A payment the provider confirmed. */
export type PaidOrder = { orderId: string; providerTxnId: string; amountFen: number };

/** One way to pay: WeChat Pay, Alipay, or the development-only test provider. */
export type PaymentProvider = {
  id: "wechat" | "alipay" | "test";
  configured(): boolean;
  /** Creates a QR-code order; returns the string to encode as the QR code. */
  createQrOrder(order: QrOrder): Promise<{ qrCode: string }>;
  /** Verifies a notification's signature and returns the paid order, or null (invalid, unpaid, or unrelated). */
  parseNotification(request: {
    headers: Record<string, string | string[] | undefined>;
    rawBody: string;
  }): Promise<PaidOrder | null>;
  /** What to answer the provider after handling a notification. */
  notificationAnswer(accepted: boolean): { status: number; contentType: string; body: string };
  /** Asks the provider whether an order was paid (polling fallback). */
  queryOrder(orderId: string): Promise<PaidOrder | null>;
  /** Closes an unpaid order at the provider (best effort). */
  closeOrder(orderId: string): Promise<void>;
};
