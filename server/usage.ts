import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger } from "./logger";
import { signatureHeaders, urlAllowed } from "./tools/webhook";

/**
 * Usage metering: how many voice minutes each user spent, so the relay's
 * owner can bill for them, cap them, or simply see where the model budget
 * goes.
 *
 * Three rules keep it predictable:
 *
 * - **What is counted** is the time a voice connection is open, by the
 *   second. A 90-second session is 1.5 minutes. Tool calls are counted too.
 * - **Who it belongs to** is the session's user: the signed-in account, or the
 *   `userId` on the session token the owner's backend minted. Sessions with
 *   no user are counted under "anonymous".
 * - **Months** are calendar months in UTC (`2026-11`).
 *
 * Totals are kept in `usage.json` in the relay's data directory. Each finished
 * session can also be POSTed to the owner's billing system
 * (USAGE_WEBHOOK_URL), signed like tool webhooks. See docs/usage-and-billing.md.
 * A totals file that is there but cannot be read is never written over. The
 * relay moves it aside, saves nothing until that copy is dealt with, and says
 * so on /ready (readinessIssue below).
 */

const ANONYMOUS = "anonymous";

type SessionUsage = {
  sessionId: string;
  /** Undefined for sessions without a user. */
  userId?: string;
  startedAt: number;
  endedAt: number;
  seconds: number;
  toolCalls: number;
};

type Totals = { sessions: number; seconds: number; toolCalls: number };
type Store = { version: 1; months: Record<string, Record<string, Totals>> };

export type UsageSettings = {
  /** Where totals are kept. */
  file: string;
  /** Monthly minutes per user; 0 turns limits off. */
  monthlyMinutes: number;
  webhookUrl?: string;
  webhookSecret?: string;
};

const log = createLogger("usage");
const MAX_USERS_PER_MONTH = 100_000;
const MAX_MONTHS_KEPT = 24;

/** "2026-11" for a time. */
export function monthOf(at: number): string {
  return new Date(at).toISOString().slice(0, 7);
}

function positiveNumber(raw: string | undefined): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** The settings from the environment. */
export function usageSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): UsageSettings {
  const dataDir = env.STUDIO_DIR?.trim() || path.join(os.homedir(), ".max-relay");
  return {
    file: path.join(dataDir, "usage.json"),
    monthlyMinutes: positiveNumber(env.USAGE_MONTHLY_MINUTES),
    webhookUrl: env.USAGE_WEBHOOK_URL?.trim() || undefined,
    webhookSecret: env.USAGE_WEBHOOK_SECRET?.trim() || undefined
  };
}

export type UsageMeter = {
  /** Seconds a user has used this month, including sessions still open. */
  usedSeconds(userId: string | undefined, at?: number): number;
  /** True when the user may not start (or continue) a session. */
  overLimit(userId: string | undefined, at?: number): boolean;
  /** The monthly limit in minutes, or 0 when there is none. */
  limitMinutes(): number;
  /** Starts timing a connection. Call the returned function when it ends. */
  open(sessionId: string, userId: string | undefined, at?: number): OpenSession;
  /** Totals for one month, per user. */
  report(month: string, userId?: string): UsageReport;
  /** Writes pending totals now (shutdown). */
  flush(): void;
  /** Why the totals file could not be read when the relay started, and what became of it. For /ready. */
  readonly readinessIssue: string | undefined;
  /**
   * True while new sessions must be refused. The per-user allowance is enforced
   * from the totals file, and when that could not be read they start from
   * nothing at every restart, which would hand everybody their allowance again.
   * Without an allowance the meter only reports, and sessions go on.
   */
  refusesNewSessions(): boolean;
};

type OpenSession = {
  /** A tool call was made in this session. */
  toolCall(): void;
  /** Ends the session and records it. Safe to call twice. */
  close(at?: number): SessionUsage | undefined;
};

type UsageReport = {
  month: string;
  limitMinutes: number;
  totals: { sessions: number; minutes: number; seconds: number; toolCalls: number };
  users: Array<{ userId: string; sessions: number; minutes: number; seconds: number; toolCalls: number }>;
};

const minutes = (seconds: number) => Math.round((seconds / 60) * 100) / 100;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTotals = (value: unknown): value is Totals =>
  isRecord(value) &&
  typeof value.sessions === "number" &&
  typeof value.seconds === "number" &&
  typeof value.toolCalls === "number";

/** The shape the meter writes and counts on from: every month, user and counter where it expects them. */
function isStore(value: unknown): value is Store {
  return (
    isRecord(value) &&
    value.version === 1 &&
    isRecord(value.months) &&
    Object.values(value.months).every((month) => isRecord(month) && Object.values(month).every(isTotals))
  );
}

/** The totals file, or why it cannot be counted on. No file at all is the first run: an empty ledger. */
function readTotals(file: string): { store: Store } | { problem: string } {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? { store: { version: 1, months: {} } }
      : { problem: `could not be read (${code ?? "error"})` };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isStore(parsed) ? { store: parsed } : { problem: "is not a usage file" };
  } catch {
    return { problem: "is not JSON" };
  }
}

/** The damaged totals files kept beside `file`, oldest first. What keeps the relay unready until they are dealt with. */
function keptCopies(file: string): string[] {
  const prefix = `${path.basename(file)}.corrupt-`;
  try {
    return fs
      .readdirSync(path.dirname(file))
      .filter((name) => name.startsWith(prefix))
      .sort();
  } catch {
    // No directory yet is the first run. Anything else is said by the first save.
    return [];
  }
}

/** What an owner does about kept copies of the totals file, said the same wherever they are reported. */
function keptCopyAdvice(count: number, name: string): string {
  const one = count === 1;
  return `Move or delete ${one ? "it" : "them"}, then start the relay again; to keep ${one ? "its" : "their"} totals, put a good ${name} back as well.`;
}

export function createUsageMeter(
  settings: UsageSettings,
  options: { now?: () => number; request?: typeof fetch; persist?: boolean } = {}
): UsageMeter {
  const now = options.now ?? Date.now;
  const request = options.request ?? fetch;
  let persist = options.persist ?? true;
  let store: Store = { version: 1, months: {} };
  const live = new Map<string, { userKey: string; startedAt: number }>();
  let writeTimer: NodeJS.Timeout | undefined;
  let readinessIssue: string | undefined;

  if (persist) {
    const name = path.basename(settings.file);
    const read = readTotals(settings.file);
    if ("problem" in read) {
      // A file is there and cannot be counted on. Counting from nothing is all
      // that is left, but it must not pass for the first run: the next save
      // would write an empty ledger over the owner's billing history, and
      // everybody would have their monthly allowance again. So the file is
      // kept and the relay says that it is not ready.
      const aside = `${settings.file}.corrupt-${new Date(now()).toISOString()}`;
      try {
        fs.renameSync(settings.file, aside);
        readinessIssue =
          `usage-storage-unavailable: ${name} ${read.problem}, so it was moved aside to ${path.basename(aside)}. ` +
          `Totals started empty, and nothing is saved while the kept copy is there. ${keptCopyAdvice(1, name)}`;
        log.error(
          "usage totals file could not be read: it was moved aside, and nothing is saved until the copy is dealt with and the relay started again",
          { file: settings.file, movedTo: aside, problem: read.problem }
        );
      } catch (error) {
        readinessIssue =
          `usage-storage-unavailable: ${name} ${read.problem}, and it could not be moved aside. Nothing is saved, ` +
          `and totals started empty. Stop the relay, repair ${name}, and start it again.`;
        log.error(
          "usage totals file could not be read and could not be moved aside: nothing is saved, and the relay is not ready until it is repaired and started again",
          {
            file: settings.file,
            problem: read.problem,
            moveError: error instanceof Error ? error.message : String(error)
          }
        );
      }
    } else {
      store = read.store;
      // The totals file is missing or readable, but a damaged one is still
      // kept beside it: an earlier start moved it there and the owner has not
      // dealt with it yet. A start that finds the path free must not pass for
      // a clean one, or a restart alone would clear the problem.
      const kept = keptCopies(settings.file);
      if (kept.length > 0) {
        readinessIssue =
          `usage-storage-unavailable: ${kept.join(", ")}: kept beside ${name}, and those totals were never loaded. ` +
          `Nothing is saved while a kept copy is there. ${keptCopyAdvice(kept.length, name)}`;
        log.error(
          "a damaged usage totals file is still kept beside the totals file: nothing is saved until it is dealt with and the relay started again",
          { kept }
        );
      }
    }
    // Nothing is written while the ledger is in doubt: not to the kept copy,
    // and not to the totals file either, which the owner may be about to
    // replace with a good one. What is counted meanwhile stays in memory.
    if (readinessIssue) persist = false;
  }

  let webhookProblem: string | undefined;
  if (settings.webhookUrl) {
    try {
      if (!urlAllowed(new URL(settings.webhookUrl)))
        webhookProblem = "USAGE_WEBHOOK_URL must be https (plain http only to local or private hosts)";
    } catch {
      webhookProblem = "USAGE_WEBHOOK_URL is not a URL";
    }
    if (webhookProblem) log.warn(webhookProblem);
  }

  function write(): void {
    writeTimer = undefined;
    if (!persist) return;
    try {
      fs.mkdirSync(path.dirname(settings.file), { recursive: true });
      const temporary = `${settings.file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(store), { mode: 0o600 });
      fs.renameSync(temporary, settings.file);
    } catch (error) {
      log.warn("usage totals could not be saved", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  function scheduleWrite(): void {
    if (!writeTimer) {
      writeTimer = setTimeout(write, 2000);
      writeTimer.unref?.();
    }
  }

  function add(month: string, userKey: string, usage: SessionUsage): void {
    const users = (store.months[month] ??= {});
    if (!users[userKey] && Object.keys(users).length >= MAX_USERS_PER_MONTH) userKey = "other";
    const totals = (users[userKey] ??= { sessions: 0, seconds: 0, toolCalls: 0 });
    totals.sessions += 1;
    totals.seconds = Math.round((totals.seconds + usage.seconds) * 1000) / 1000;
    totals.toolCalls += usage.toolCalls;
    const months = Object.keys(store.months).sort();
    for (const old of months.slice(0, Math.max(0, months.length - MAX_MONTHS_KEPT))) delete store.months[old];
    scheduleWrite();
  }

  async function notify(usage: SessionUsage): Promise<void> {
    if (!settings.webhookUrl || webhookProblem) return;
    const body = JSON.stringify({ type: "session.usage", ...usage, minutes: minutes(usage.seconds) });
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(settings.webhookSecret ? signatureHeaders(body, settings.webhookSecret, now()) : {})
    };
    // Billing data: a few attempts before giving up. GET /v1/usage stays the
    // record to reconcile against.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await request(settings.webhookUrl, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(10_000),
          redirect: "error"
        });
        if (response.ok) return;
        log.warn("usage webhook refused a session", { status: response.status, attempt });
      } catch (error) {
        log.warn("usage webhook failed", { message: error instanceof Error ? error.message : String(error), attempt });
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
    }
  }

  function usedSeconds(userId: string | undefined, at = now()): number {
    const userKey = userId ?? ANONYMOUS;
    const month = monthOf(at);
    let seconds = store.months[month]?.[userKey]?.seconds ?? 0;
    for (const session of live.values()) {
      if (session.userKey !== userKey) continue;
      seconds += Math.max(0, at - Math.max(session.startedAt, Date.parse(`${month}-01T00:00:00Z`))) / 1000;
    }
    return seconds;
  }

  return {
    usedSeconds,
    limitMinutes: () => settings.monthlyMinutes,
    overLimit(userId, at = now()) {
      // Limits are per user: an unknown user has no allowance of their own to use up.
      if (!settings.monthlyMinutes || !userId) return false;
      return usedSeconds(userId, at) >= settings.monthlyMinutes * 60;
    },
    open(sessionId, userId, at = now()) {
      const userKey = userId ?? ANONYMOUS;
      live.set(sessionId, { userKey, startedAt: at });
      let toolCalls = 0;
      let closed: SessionUsage | undefined;
      return {
        toolCall() {
          toolCalls += 1;
        },
        close(endedAt = now()) {
          if (closed) return closed;
          live.delete(sessionId);
          closed = {
            sessionId,
            ...(userId ? { userId } : {}),
            startedAt: at,
            endedAt,
            seconds: Math.max(0, Math.round(endedAt - at) / 1000),
            toolCalls
          };
          // A session that spans midnight at a month's end is booked to the
          // month it ended in: one record, one invoice line.
          add(monthOf(endedAt), userKey, closed);
          void notify(closed);
          return closed;
        }
      };
    },
    report(month, userId) {
      const users = Object.entries(store.months[month] ?? {})
        .filter(([key]) => !userId || key === userId)
        .map(([key, totals]) => ({
          userId: key,
          sessions: totals.sessions,
          minutes: minutes(totals.seconds),
          seconds: totals.seconds,
          toolCalls: totals.toolCalls
        }))
        .sort((a, b) => b.seconds - a.seconds);
      const seconds = users.reduce((sum, user) => sum + user.seconds, 0);
      return {
        month,
        limitMinutes: settings.monthlyMinutes,
        totals: {
          sessions: users.reduce((sum, user) => sum + user.sessions, 0),
          minutes: minutes(seconds),
          seconds: Math.round(seconds * 1000) / 1000,
          toolCalls: users.reduce((sum, user) => sum + user.toolCalls, 0)
        },
        users
      };
    },
    readinessIssue,
    refusesNewSessions: () => Boolean(readinessIssue) && settings.monthlyMinutes > 0,
    flush() {
      if (writeTimer) clearTimeout(writeTimer);
      write();
    }
  };
}
