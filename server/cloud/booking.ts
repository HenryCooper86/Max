// Booking Max Cloud sessions into the ledger, and making sure none is lost on
// the way: every session has a row in live_sessions from its start until its
// booking is in the ledger (store.ts explains the row's life). A booking that
// fails keeps its row and is retried; a relay that dies leaves rows that
// another relay process (or itself, after a restart) books up to their last
// checkpoint. Booking is idempotent on the session id, so a retry or two
// relays racing to book the same row can never charge twice.

import { createLogger } from "../logger";
import { bookedSeconds, secondsForFen } from "./billing";
import { countCloud, type CloudCounter } from "./counters";
import { cloudEnabled, cloudInstanceId, now } from "./context";
import {
  bookUsage,
  customerExists,
  customerFunds,
  endLiveSession,
  finishLiveSession,
  liveSessionRows,
  liveSessionSeconds,
  sessionSecondsBooked,
  startLiveSession,
  touchLiveSession,
  unbookedLiveSessions,
  type LiveSessionRow
} from "./store";

const log = createLogger("cloud");

const LATEST_DATE_MS = 8.64e15;

/**
 * How long a running session's row may go without a checkpoint before it is
 * taken for abandoned. Relays checkpoint every 5 s (releases before this one,
 * which may still be running during a rolling upgrade, every 15 s), so a live
 * relay is never this late. A session booked this way while it was in fact
 * still running (its relay, or the database, stalled for longer than this)
 * has the rest booked when it closes: see bookUsage.
 */
const ABANDONED_AFTER_MS = 60_000;

export type SessionUsage = {
  customerId: string;
  projectId: string;
  sessionId: string;
  seconds: number;
  endedAt: number;
};

/**
 * What happened to a booking. Only "failed" leaves money unaccounted for, and
 * is retried. "not-billable" is final: a session that never got to talk (0
 * seconds, nothing to write to a money ledger) or one that names no customer
 * there is to charge.
 */
export type ChargeOutcome = "booked" | "already-booked" | "not-billable" | "failed";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Books one finished session (idempotent on sessionId). Never throws. */
export function chargeSession(usage: SessionUsage): ChargeOutcome {
  const { customerId, projectId, sessionId } = usage;
  if (![customerId, projectId, sessionId].every((value) => typeof value === "string" && value.length > 0)) {
    log.warn("session not booked: missing customer, project or session id");
    return "not-billable";
  }
  const endedAt =
    Number.isFinite(usage.endedAt) && usage.endedAt > 0 && usage.endedAt < LATEST_DATE_MS ? usage.endedAt : now();
  const seconds = bookedSeconds(usage.seconds);
  if (seconds === 0) return "not-billable";
  try {
    if (!customerExists(customerId)) {
      log.error("session of an unknown customer not booked", { customerId, projectId, sessionId, seconds });
      return "not-billable";
    }
    const booking = bookUsage({ customerId, projectId, sessionId, seconds, endedAt, at: now() });
    if (booking === "already-booked") {
      log.debug("session already booked", { sessionId });
      return "already-booked";
    }
    if (booking === "remainder") {
      log.warn("booked the rest of a session that had been booked early as abandoned", { sessionId, seconds });
      return "booked";
    }
    countCloud("max_cloud_sessions_booked_total");
    return "booked";
  } catch (error) {
    // Called when a voice connection closes: a failure must not take the relay
    // down. The caller keeps the session's row, so it is retried.
    countCloud("max_cloud_booking_failures_total");
    log.error("session not booked; it will be retried", {
      customerId,
      projectId,
      sessionId,
      seconds,
      endedAt,
      message: describeError(error)
    });
    return "failed";
  }
}

/** A project session began: recorded so a crash cannot lose its charge. */
export function cloudSessionStarted(session: { sessionId: string; customerId: string; projectId: string }): void {
  try {
    startLiveSession({ ...session, instanceId: cloudInstanceId(), at: now() });
  } catch (error) {
    log.warn("live session not recorded", { message: describeError(error) });
  }
}

/**
 * A project session is still running, with `seconds` billable so far (a
 * checkpoint, every few seconds). True when its row had to be written again,
 * which means part of the session may already be in the ledger.
 */
export function cloudSessionAlive(
  session: { sessionId: string; customerId: string; projectId: string },
  seconds: number
): boolean {
  try {
    const outcome = touchLiveSession({
      ...session,
      instanceId: cloudInstanceId(),
      at: now(),
      seconds: Math.max(0, seconds)
    });
    if (outcome === "restored") {
      // Its start was never recorded, or another relay took it for abandoned
      // (this one stalled, or the database did) and booked it up to its last
      // checkpoint. The close books whatever the ledger does not hold yet.
      log.warn("a running session's checkpoint row was missing and has been written again", {
        sessionId: session.sessionId
      });
      return true;
    }
  } catch {
    /* the close or the next checkpoint records it */
  }
  return false;
}

/** Seconds of a session the ledger already holds (booked early as abandoned); 0 when it cannot be read. */
export function secondsAlreadyBooked(sessionId: string): number {
  try {
    return sessionSecondsBooked(sessionId);
  } catch {
    return 0;
  }
}

/** Deletes a booked session's row; a row left behind is retried and found already booked. */
function forget(sessionId: string): void {
  try {
    endLiveSession(sessionId);
  } catch (error) {
    log.warn("booked session's row not cleared; the next retry clears it", {
      sessionId,
      message: describeError(error)
    });
  }
}

// Sessions whose end could not even be written down (the database refused
// both writes): retried from memory while this process lives. If it dies
// first, their start row is booked up to its last checkpoint instead.
const unrecorded = new Map<string, SessionUsage>();

/** A project session ended: record its final length, book it, and forget it once booked. */
export function cloudSessionEnded(usage: SessionUsage): ChargeOutcome {
  let recorded = true;
  try {
    finishLiveSession({ ...usage, seconds: Math.max(0, usage.seconds), instanceId: cloudInstanceId() });
  } catch (error) {
    recorded = false;
    log.warn("ended session not recorded", { sessionId: usage.sessionId, message: describeError(error) });
  }
  const outcome = chargeSession(usage);
  if (outcome !== "failed") forget(usage.sessionId);
  else if (!recorded) unrecorded.set(usage.sessionId, { ...usage });
  return outcome;
}

function rowUsage(row: LiveSessionRow): SessionUsage {
  return {
    customerId: row.customer_id,
    projectId: row.project_id,
    sessionId: row.session_id,
    seconds: liveSessionSeconds(row),
    endedAt: row.ended_at ?? row.last_seen
  };
}

/**
 * Books what is waiting: sessions whose booking failed, and sessions of relay
 * processes that stopped checkpointing (crashed, killed, or this relay before
 * a restart) up to their last checkpoint. Safe to run from any number of
 * relays at once. Run at startup and then periodically. Returns how many
 * sessions it booked.
 */
export function recoverCloudSessions(): number {
  if (!cloudEnabled()) return 0;
  let booked = 0;
  const settle = (usage: SessionUsage, counter: CloudCounter): void => {
    const outcome = chargeSession(usage);
    if (outcome === "failed") return;
    unrecorded.delete(usage.sessionId);
    forget(usage.sessionId);
    if (outcome !== "booked") return;
    booked += 1;
    countCloud(counter);
  };
  for (const usage of [...unrecorded.values()]) settle(usage, "max_cloud_bookings_retried_total");
  let rows: LiveSessionRow[] = [];
  try {
    rows = unbookedLiveSessions(cloudInstanceId(), now() - ABANDONED_AFTER_MS);
  } catch (error) {
    log.warn("unbooked sessions could not be read", { message: describeError(error) });
  }
  for (const row of rows) {
    settle(
      rowUsage(row),
      row.ended_at !== null ? "max_cloud_bookings_retried_total" : "max_cloud_sessions_recovered_total"
    );
  }
  if (booked) log.info("booked sessions that were waiting", { sessions: booked });
  return booked;
}

/**
 * Seconds this customer can still talk: free seconds left this month plus the
 * balance at 15 fen/min, minus sessions not booked yet (running on another
 * relay, or waiting for a retried booking). Sessions in `running` are left
 * out: the caller counts them from its own, more recent clock.
 */
export function remainingSeconds(customerId: string, at?: number, running?: ReadonlySet<string>): number {
  if (typeof customerId !== "string" || !customerExists(customerId)) return 0;
  const funds = customerFunds(customerId, at ?? now());
  return funds.freeSecondsLeft + secondsForFen(funds.fen) - unbookedSeconds({ customerId }, running);
}

/** Seconds of not-yet-booked sessions of a customer or project, leaving out `running`. */
export function unbookedSeconds(
  scope: { customerId: string } | { projectId: string },
  running?: ReadonlySet<string>
): number {
  let rows: LiveSessionRow[];
  try {
    rows = liveSessionRows(scope);
  } catch {
    return 0;
  }
  let seconds = 0;
  for (const row of rows) {
    if (running?.has(row.session_id)) continue;
    // A session booked early as abandoned and still running has a row again:
    // only what the ledger does not hold yet is unbooked.
    seconds += Math.max(0, bookedSeconds(liveSessionSeconds(row)) - secondsAlreadyBooked(row.session_id));
  }
  return seconds;
}
