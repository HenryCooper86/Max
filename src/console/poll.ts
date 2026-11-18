import type { OrderStatus } from "./api";

export const TOPUP_POLL_MS = 2000;

/** Whether to ask about a top-up order again: only while it is pending and
 *  has not passed its expiry. */
export function shouldKeepPolling(status: OrderStatus | undefined, expiresAt: number, now: number): boolean {
  if (status === "paid" || status === "closed") return false;
  return now < expiresAt;
}

/** Expiry times may arrive in seconds or milliseconds; compare in milliseconds. */
export function toMillis(timestamp: number): number {
  return timestamp < 1e11 ? timestamp * 1000 : timestamp;
}
