// Max Cloud sessions running on this relay: whether a new one may start,
// how long each has been billable, and the check every few seconds that
// checkpoints it and ends it when its customer's money, its project's monthly
// limit or its project key runs out. The relay's socket code (server/index.ts)
// only wires these to the connection.
//
// What is billed is the time the voice model could talk: from the moment the
// upstream is ready, paused while the relay reconnects to it, until the
// connection closes. The provider reports that through its `status` events
// (server/providers/live/session.ts): "connecting" before the upstream is
// ready or while it reconnects, "closed" once it has given up, and any other
// state (ready, listening, thinking, speaking, ...) while it is connected.

import { USAGE_LIMIT_CLOSE_CODE, type AgentEvent } from "../../shared/agent";
import { monthOf } from "./billing";
import {
  cloudSessionAlive,
  cloudSessionStarted,
  remainingSeconds,
  secondsAlreadyBooked,
  unbookedSeconds
} from "./booking";
import { countCloud } from "./counters";
import { cloudEnabled, now } from "./context";
import { createLogger } from "../logger";
import { liveProjectByKeyHash, markWebsiteConversation, projectMinutesCap, projectSecondsIn } from "./store";

const log = createLogger("cloud");

/** How often a running session is checkpointed and checked. Also the least
 *  balance a session may start with, and so how far past its money a customer
 *  can go: one interval per open session. */
export const CLOUD_CHECK_INTERVAL_MS = 5_000;
/** Simultaneous sessions per customer. */
const SESSIONS_PER_CUSTOMER = 5;
/** Of those, at most this many from the public embed, which anyone visiting a listed website (or anyone
 *  faking its Origin) can start: the customer's own backend and tests always keep room. */
const EMBED_SESSIONS_PER_CUSTOMER = 3;
/** Public-embed sessions one visitor address may hold at once. Two, not one, so a visitor whose network
 *  dropped can reconnect before the relay notices the old socket is gone. */
const EMBED_SESSIONS_PER_ADDRESS = 2;

const BALANCE_MESSAGE = "Your Max Cloud balance is used up. Top up in the console.";
const LIMIT_MESSAGE =
  "This Max Cloud agent has used its minutes for this month. Its owner can raise the limit in the console.";
const REVOKED_MESSAGE = "This Max Cloud project key was rotated or the project was deleted.";

export type CloudRefusal = { code: number; message: string; reason: string };

/** What a session token says about the session (server/session-tokens.ts). */
export type CloudSessionGrant = {
  projectId: string;
  customerId: string;
  keyHash: string;
  source?: "api" | "test" | "embed";
};

/** Seconds a session could talk: runs while the upstream is connected. */
class BillableClock {
  private accumulatedMs = 0;
  private runningSince: number | undefined;

  /**
   * `upstreamUsable` is the backend's own word on whether it is connected
   * (AgentProvider.upstreamUsable). Statuses alone are not enough: muting or
   * typing while the backend reconnects reports "ready" or "hearing", and
   * that must not start the clock again.
   */
  observe(event: unknown, at: number, upstreamUsable?: boolean): void {
    const { type, state } = (event ?? {}) as { type?: unknown; state?: unknown };
    if (type !== "status" || typeof state !== "string") return;
    if (state === "connecting" || state === "closed" || upstreamUsable === false) this.stop(at);
    else this.runningSince ??= at;
  }

  stop(at: number): void {
    if (this.runningSince === undefined) return;
    this.accumulatedMs += Math.max(0, at - this.runningSince);
    this.runningSince = undefined;
  }

  seconds(at: number): number {
    const running = this.runningSince === undefined ? 0 : Math.max(0, at - this.runningSince);
    return (this.accumulatedMs + running) / 1000;
  }
}

type Running = {
  sessionId: string;
  grant: CloudSessionGrant;
  embed: boolean;
  address: string;
  clock: BillableClock;
  /** Its checkpoint row went missing once: another relay may have booked part of it already. */
  bookedEarly?: boolean;
};

const running = new Map<string, Running>();

/** Test hook: forgets every running session (the database rows stay). */
export function resetLiveCloudSessions(): void {
  running.clear();
}

function sessionsOf(match: (session: Running) => boolean): Running[] {
  return [...running.values()].filter(match);
}

/** Seconds these sessions have run that the ledger does not hold yet. */
function secondsOf(sessions: Running[], at: number): number {
  return sessions.reduce((sum, session) => {
    const booked = session.bookedEarly ? secondsAlreadyBooked(session.sessionId) : 0;
    return sum + Math.max(0, session.clock.seconds(at) - booked);
  }, 0);
}

function idsOf(sessions: Running[]): Set<string> {
  return new Set(sessions.map((session) => session.sessionId));
}

/** What the customer can still talk for, counting this relay's running sessions by their own clocks. */
function customerSecondsLeft(customerId: string, at: number): number {
  const own = sessionsOf((session) => session.grant.customerId === customerId);
  return remainingSeconds(customerId, at, idsOf(own)) - secondsOf(own, at);
}

/**
 * Whether the project has reached its owner's monthly minutes limit, counting
 * this month's bookings, sessions not booked yet (on other relays, or waiting
 * for a retry) and this relay's running sessions. Counted as a refusal when
 * it has; undefined when there is no limit or room is left.
 */
export function projectLimitRefusal(projectId: string, at = now()): CloudRefusal | undefined {
  const cap = projectMinutesCap(projectId);
  if (!cap) return undefined;
  const own = sessionsOf((session) => session.grant.projectId === projectId);
  const used =
    projectSecondsIn(projectId, monthOf(at)) + unbookedSeconds({ projectId }, idsOf(own)) + secondsOf(own, at);
  if (used < cap * 60) return undefined;
  countCloud("max_cloud_spend_cap_refusals_total");
  return { code: USAGE_LIMIT_CLOSE_CODE, message: LIMIT_MESSAGE, reason: "project monthly limit" };
}

/**
 * Why a new session of this grant may not start now, from `address`;
 * undefined when it may. When the balance cannot be read the session is
 * refused: nobody talks on money that could not be checked.
 */
export function admitCloudSession(grant: CloudSessionGrant, address: string): CloudRefusal | undefined {
  try {
    return admission(grant, address);
  } catch (error) {
    log.warn("cloud session not admitted: the store could not be read", {
      message: error instanceof Error ? error.message : String(error)
    });
    return { code: 1013, message: "Max Cloud is busy. Try again in a moment.", reason: "cloud store unavailable" };
  }
}

function admission(grant: CloudSessionGrant, address: string): CloudRefusal | undefined {
  const at = now();
  const customerSessions = sessionsOf((session) => session.grant.customerId === grant.customerId);
  if (customerSessions.length >= SESSIONS_PER_CUSTOMER) {
    return {
      code: 1013,
      message: `This Max Cloud account already has ${SESSIONS_PER_CUSTOMER} voice sessions open.`,
      reason: "too many sessions"
    };
  }
  if (grant.source === "embed") {
    const embeds = customerSessions.filter((session) => session.embed);
    if (embeds.length >= EMBED_SESSIONS_PER_CUSTOMER) {
      return {
        code: 1013,
        message: "This assistant is busy right now. Try again in a minute.",
        reason: "too many embed sessions"
      };
    }
    if (embeds.filter((session) => session.address === address).length >= EMBED_SESSIONS_PER_ADDRESS) {
      return {
        code: 1013,
        message: "You already have conversations open with this assistant. Close one and try again.",
        reason: "too many embed sessions from one address"
      };
    }
  }
  const limit = projectLimitRefusal(grant.projectId, at);
  if (limit) return limit;
  if (customerSecondsLeft(grant.customerId, at) < CLOUD_CHECK_INTERVAL_MS / 1000) {
    return { code: USAGE_LIMIT_CLOSE_CODE, message: BALANCE_MESSAGE, reason: "balance used up" };
  }
  return undefined;
}

export type LiveCloudSession = {
  /** Every event the voice provider sends the client: its status drives the billed time. */
  observe(event: unknown, upstreamUsable?: boolean): void;
  /** Billable seconds so far. */
  seconds(): number;
  /** The periodic check: checkpoints the session and says why it must end, once. */
  check(): CloudRefusal | undefined;
  /** The session ended: stops its clock, forgets it and returns its billable seconds. */
  close(endedAt?: number): number;
};

/** Starts tracking an admitted session; its row in live_sessions is written now. */
export function openCloudSession(
  sessionId: string,
  grant: CloudSessionGrant,
  address: string,
  origin?: string
): LiveCloudSession {
  const session: Running = {
    sessionId,
    grant: { ...grant },
    embed: grant.source === "embed",
    address,
    clock: new BillableClock()
  };
  running.set(sessionId, session);
  cloudSessionStarted({ sessionId, customerId: grant.customerId, projectId: grant.projectId });
  // The widget has its own grant; the SDK can also run in a browser using a server-minted token.
  let trackingWebsite = grant.source !== "test" && (session.embed || /^https?:\/\//i.test(origin ?? ""));
  let visitorSpoke = false;
  let answeredAt: number | undefined;
  function recordWebsiteAnswer() {
    if (!trackingWebsite || answeredAt === undefined) return;
    try {
      markWebsiteConversation(grant.projectId, answeredAt);
      trackingWebsite = false;
    } catch (error) {
      log.warn("website conversation milestone could not be saved", { sessionId, message: String(error) });
    }
  }
  let refused = false;
  let closedSeconds: number | undefined;

  const refuse = (refusal: CloudRefusal): CloudRefusal => {
    refused = true;
    return refusal;
  };

  return {
    observe(event, upstreamUsable) {
      if (closedSeconds !== undefined) return;
      const at = now();
      session.clock.observe(event, at, upstreamUsable);
      if (!trackingWebsite || answeredAt !== undefined) return;
      const payload = event as Partial<AgentEvent> | null;
      if (payload?.type === "status" && payload.state === "closed") visitorSpoke = false;
      if (upstreamUsable === false) return;
      // Cloud voice providers send this metric with the first audio answering a visitor,
      // including when recognition has not delivered the visitor's final words yet.
      if (
        payload?.type === "metric" &&
        typeof payload.latencyMs === "number" &&
        Number.isFinite(payload.latencyMs) &&
        payload.latencyMs >= 0
      ) {
        answeredAt = at;
      } else if (
        payload?.type === "transcript" &&
        payload.final === true &&
        typeof payload.text === "string" &&
        payload.text.trim()
      ) {
        if (payload.speaker === "rider") visitorSpoke = true;
        if (visitorSpoke && payload.speaker === "agent") answeredAt = at;
      }
      recordWebsiteAnswer();
    },
    seconds() {
      return closedSeconds ?? session.clock.seconds(now());
    },
    check() {
      if (refused || closedSeconds !== undefined) return undefined;
      const at = now();
      recordWebsiteAnswer();
      const restored = cloudSessionAlive(
        { sessionId, customerId: grant.customerId, projectId: grant.projectId },
        session.clock.seconds(at)
      );
      if (restored) session.bookedEarly = true;
      try {
        if (!cloudEnabled() || liveProjectByKeyHash(grant.keyHash)?.id !== grant.projectId) {
          countCloud("max_cloud_sessions_killed_key_rotation_total");
          return refuse({ code: 1008, message: REVOKED_MESSAGE, reason: "project revoked" });
        }
        const limit = projectLimitRefusal(grant.projectId, at);
        if (limit) return refuse(limit);
        if (customerSecondsLeft(grant.customerId, at) <= 0) {
          return refuse({ code: USAGE_LIMIT_CLOSE_CODE, message: BALANCE_MESSAGE, reason: "balance used up" });
        }
      } catch (error) {
        // A running conversation is not cut off by a database hiccup; the next check reads it again.
        log.warn("cloud session check skipped: the store could not be read", {
          sessionId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
      return undefined;
    },
    close(endedAt = now()) {
      if (closedSeconds !== undefined) return closedSeconds;
      recordWebsiteAnswer();
      session.clock.stop(endedAt);
      closedSeconds = session.clock.seconds(endedAt);
      running.delete(sessionId);
      return closedSeconds;
    }
  };
}
