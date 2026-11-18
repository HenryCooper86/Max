// Max Cloud's money rules, as pure functions. All amounts are integer fen (¥0.01).

const PRICE_FEN_PER_MINUTE = 15;
const FREE_SECONDS_PER_MONTH = 60_000;
export const ORDER_LIFETIME_MS = 15 * 60_000;

export const PACKS = [
  { id: "cny50", fen: 5_000 },
  { id: "cny200", fen: 20_000 },
  { id: "cny1000", fen: 100_000 }
] as const;

export function packById(id: unknown): (typeof PACKS)[number] | undefined {
  return PACKS.find((pack) => pack.id === id);
}

/** The UTC calendar month of a time, as "2026-11". */
export function monthOf(at: number): string {
  return new Date(at).toISOString().slice(0, 7);
}

/** Session length as booked: whole seconds, rounded up, never negative. */
export function bookedSeconds(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.ceil(seconds);
}

/** How a session of `seconds` (whole) is paid for: free seconds first, then fen, rounded up. */
export function usageCharge(seconds: number, freeSecondsLeft: number): { freeSeconds: number; costFen: number } {
  const freeSeconds = Math.min(seconds, Math.max(0, freeSecondsLeft));
  const paidSeconds = seconds - freeSeconds;
  return { freeSeconds, costFen: Math.ceil((paidSeconds * PRICE_FEN_PER_MINUTE) / 60) };
}

/** Free seconds left in a month after `used` of them. */
export function freeSecondsLeft(used: number): number {
  return Math.max(0, FREE_SECONDS_PER_MONTH - used);
}

/** Talk time a balance buys, in whole seconds (negative for a negative balance). */
export function secondsForFen(fen: number): number {
  return Math.floor((fen * 60) / PRICE_FEN_PER_MINUTE);
}
