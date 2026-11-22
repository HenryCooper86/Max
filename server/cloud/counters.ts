// Max Cloud's money counters, for the relay's metrics endpoint. Monotonic for
// the life of the process (a restart starts them at zero, as Prometheus
// counters expect), named in Prometheus style so they can be exported as is.

const NAMES = [
  /** A finished session was written to the ledger. */
  "max_cloud_sessions_booked_total",
  /** Writing a finished session to the ledger failed; the session is kept to retry. */
  "max_cloud_booking_failures_total",
  /** A session whose first booking failed was booked by a later retry. */
  "max_cloud_bookings_retried_total",
  /** A session left open by a crashed or stopped relay was booked up to its last checkpoint. */
  "max_cloud_sessions_recovered_total",
  /** A paid top-up was credited to a balance. */
  "max_cloud_topups_credited_total",
  /** A payment notification or query named an order that could not be credited. */
  "max_cloud_topups_refused_total",
  /** A running session was closed because its project key was rotated or the project deleted. */
  "max_cloud_sessions_killed_key_rotation_total",
  /** A token or session was refused, or a session closed, by a project's monthly minutes limit. */
  "max_cloud_spend_cap_refusals_total"
] as const;

export type CloudCounter = (typeof NAMES)[number];

const values = new Map<CloudCounter, number>(NAMES.map((name) => [name, 0]));

export function countCloud(name: CloudCounter, by = 1): void {
  values.set(name, (values.get(name) ?? 0) + by);
}

/** Every counter with its current value, zeros included, so a scrape always sees the full set. */
export function cloudCounters(): Record<string, number> {
  return Object.fromEntries(values);
}
