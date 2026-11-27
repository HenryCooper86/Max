// Max Cloud's usage per end user: what a project's sessions used in a month
// for each `userId` their session tokens named. The owner reads it to bill
// their users by and to see who is near the per-user monthly limit
// (server/cloud/live.ts), and a month's rows add up to the project's minutes
// in the ledger. The report has the shape of the relay's own
// (server/usage.ts), without tool calls, which Max Cloud does not count.

import { monthOf } from "./billing";
import type { Result } from "./customers";
import { now } from "./context";
import { projectForApiKey } from "./keys";
import { allowed } from "./sessions";
import { ANONYMOUS_USER, perUserMinutesCap, userUsageRows, userUsageTotals } from "./store";

const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/;
/** As long as a userId may be (server/session-tokens.ts). */
const MAX_USER_ID_CHARS = 128;
/** Users in one report, the most a page holds. A month with more has them in pages (`offset`). */
const MAX_LIMIT = 1_000;
/** Reports one project may ask for in a minute with its key: the key is out on the owner's servers, and each report reads its month. */
const REPORTS_PER_MINUTE_PER_PROJECT = 60;

type UserUsage = { userId: string; sessions: number; minutes: number; seconds: number };

type UserUsageReport = {
  month: string;
  /** The project's limit on each user's minutes a month; 0 when it has none. */
  limitMinutes: number;
  /** Of every user of the month, listed or not. */
  totals: { sessions: number; minutes: number; seconds: number };
  /** The users with the most seconds first. Sessions with no userId are the user "anonymous". */
  users: UserUsage[];
  /** How many users the month has, listed or not; the sessions without one are no user. */
  userCount: number;
};

/** What a report is asked for: the query of GET /v1/usage with a project key, or of the console's usage route. */
type UsageQuery = { month?: unknown; userId?: unknown; limit?: unknown; offset?: unknown };

const fail = (status: number, error: string) => ({ ok: false as const, status, error });

const minutes = (seconds: number) => Math.round((seconds / 60) * 100) / 100;

/** A whole number from `min` to `max`, as a query sends it (digits) or as a number; `fallback` when it was not sent. */
function wholeNumber(raw: unknown, fallback: number, min: number, max: number): number | undefined {
  if (raw === undefined) return fallback;
  const text = typeof raw === "string" && /^\d+$/.test(raw.trim()) ? raw.trim() : "";
  const value = typeof raw === "number" ? raw : text ? Number(text) : NaN;
  return Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

/**
 * A project's usage of a month per user. `month` is the current one unless
 * sent, as "2026-11". `userId` asks for one user ("anonymous" for the sessions
 * that named none). `users` is a page: `limit` users (1,000 unless sent) from
 * `offset`, the ones with the most seconds first.
 */
export function userUsageReport(projectId: string, query: UsageQuery, at = now()): Result<UserUsageReport> {
  const month = query.month ?? monthOf(at);
  if (typeof month !== "string" || !MONTH.test(month)) return fail(400, "month must look like 2026-11.");
  let userId: string | undefined;
  if (query.userId !== undefined) {
    if (typeof query.userId !== "string" || query.userId.length > MAX_USER_ID_CHARS) {
      return fail(400, `userId must be text of at most ${MAX_USER_ID_CHARS} characters.`);
    }
    userId = query.userId === ANONYMOUS_USER ? "" : query.userId || undefined;
  }
  const limit = wholeNumber(query.limit, MAX_LIMIT, 1, MAX_LIMIT);
  if (limit === undefined) return fail(400, `limit must be a whole number from 1 to ${MAX_LIMIT}.`);
  const offset = wholeNumber(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  if (offset === undefined) return fail(400, "offset must be a whole number from 0.");

  const totals = userUsageTotals(projectId, month, userId);
  const users = userUsageRows(projectId, month, { userId, limit, offset }).map((row) => ({
    userId: row.userId || ANONYMOUS_USER,
    sessions: row.sessions,
    minutes: minutes(row.seconds),
    seconds: row.seconds
  }));
  return {
    ok: true,
    value: {
      month,
      limitMinutes: perUserMinutesCap(projectId) ?? 0,
      totals: { sessions: totals.sessions, minutes: minutes(totals.seconds), seconds: totals.seconds },
      users,
      userCount: totals.users
    }
  };
}

/**
 * GET /v1/usage with a Max Cloud project key: that project's report. The key
 * is all the request has, so a project gets at most REPORTS_PER_MINUTE_PER_PROJECT
 * reports a minute, whoever holds its key.
 */
export function projectUsageForApiKey(apiKey: string, query: UsageQuery, at = now()): Result<UserUsageReport> {
  const project = projectForApiKey(apiKey);
  if (!project) return fail(401, "Unknown or revoked project key.");
  if (!allowed(`usage:${project.projectId}`, REPORTS_PER_MINUTE_PER_PROJECT)) {
    return fail(429, `At most ${REPORTS_PER_MINUTE_PER_PROJECT} usage reports a minute per project.`);
  }
  return userUsageReport(project.projectId, query, at);
}
