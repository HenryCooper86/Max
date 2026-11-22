import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import type { Logger } from "../logger";
import { E164, MAX_CONTEXT_CHARS, MAX_VOICEMAIL_CHARS, type CallProgress } from "./twilio-calls";

/**
 * Batch outbound calls: "call this list of numbers".
 *
 * A campaign is a list of calls with the rules for placing them: how many at
 * once, how often to try again, and the hours in which calls may be placed. The
 * calls themselves go through the same `place` as POST /v1/calls, so a campaign
 * shares the relay's line limit with every other call. What becomes of each call
 * comes from the telephony module's progress events (twilio-calls.ts).
 */

type CampaignCarrier = "twilio" | "telnyx";

const CALL_STATUSES = [
  "waiting",
  "calling",
  "answered",
  "completed",
  "voicemail",
  "no-answer",
  "busy",
  "failed",
  "cancelled",
  "unknown"
] as const;
type CallStatus = (typeof CALL_STATUSES)[number];

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
type Day = (typeof DAYS)[number];

type Window = { from: string; to: string; timeZone: string; days?: Day[] };

type CampaignCall = {
  to: string;
  context?: string;
  userId?: string;
  voicemailMessage?: string;
  status: CallStatus;
  attempts: number;
  callSid?: string;
  durationMs?: number;
  endedReason?: string;
  answeredBy?: string;
  lastAttemptAt?: string;
  /** Epoch ms: a call waiting to be tried again is not placed before this. */
  notBefore?: number;
};

type Campaign = {
  id: string;
  name?: string;
  carrier?: CampaignCarrier;
  /** The address the creating request came in on: where the carrier can reach the relay, without TELEPHONY_PUBLIC_URL. */
  origin?: string;
  concurrency: number;
  attempts: number;
  retryAfterMinutes: number;
  window?: Window;
  startAt?: string;
  context?: string;
  voicemailMessage?: string;
  createdAt: string;
  cancelled: boolean;
  calls: CampaignCall[];
};

type CampaignStatus = "scheduled" | "running" | "done" | "cancelled";

type CampaignSummary = {
  id: string;
  name?: string;
  carrier?: CampaignCarrier;
  status: CampaignStatus;
  createdAt: string;
  startAt?: string;
  concurrency: number;
  attempts: number;
  retryAfterMinutes: number;
  window?: Window;
  /** Running, but outside its window: nothing is placed until it opens. */
  waitingForWindow: boolean;
  total: number;
  counts: Record<CallStatus, number>;
};

type CampaignDetail = CampaignSummary & {
  calls: Array<
    Pick<
      CampaignCall,
      "to" | "status" | "attempts" | "callSid" | "durationMs" | "endedReason" | "answeredBy" | "lastAttemptAt"
    >
  >;
};

type PlaceResult = { ok: true; callSid: string } | { ok: false; status: number; error: string };

export type CampaignOptions = {
  /** Places one call (the relay's POST /v1/calls) and reports what becomes of it to `watch`. */
  place(
    carrier: CampaignCarrier | undefined,
    input: { to: string; context?: string; userId?: string; voicemailMessage?: string },
    watch: (progress: CallProgress) => void,
    origin: string | undefined
  ): Promise<PlaceResult>;
  /** Why calls cannot be placed through this carrier at all (not set up), checked when a campaign is created. */
  notReady?(carrier: CampaignCarrier | undefined): string | undefined;
  log: Logger;
  now?: () => number;
  /** Where the campaigns are kept between restarts. Without it they live in memory. */
  file?: string;
};

type Created = { ok: true; campaign: CampaignSummary } | { ok: false; status: number; problem: string };

export type Campaigns = {
  create(body: unknown, origin?: string): Created;
  list(): CampaignSummary[];
  get(id: string): CampaignDetail | undefined;
  cancel(id: string): CampaignSummary | undefined;
  remove(id: string): { ok: true } | { ok: false; status: number; problem: string };
  /** Why the saved file could not be read, if it could not. */
  loadProblem: string | undefined;
  /** Writes what has changed and stops the timers. */
  close(): Promise<void>;
};

const MAX_CALLS = 5_000;
const MAX_ACTIVE_CAMPAIGNS = 3;
const MAX_FINISHED_CAMPAIGNS = 50;
const MAX_START_AHEAD_MS = 30 * 24 * 60 * 60_000;
/** Carriers limit how fast calls may be started. */
const PLACE_GAP_MS = 1_000;
/** When every line is busy, the relay's own limit, try again soon. */
const LINE_BUSY_RETRY_MS = 5_000;
/** How often a campaign outside its window looks at the clock. */
const WINDOW_CHECK_MS = 30_000;
const SAVE_GAP_MS = 1_000;
const RESTART_REASON = "the relay restarted during the call";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Optional text of at most `max` characters; empty text counts as absent. */
function optionalText(value: unknown, max: number, name: string): string | undefined | Error {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > max)
    return new Error(`${name} must be text of at most ${max} characters.`);
  return value.trim() || undefined;
}

function optionalInteger(value: unknown, min: number, max: number, fallback: number, name: string): number | Error {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return new Error(`${name} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

function timeZoneIsValid(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function parseWindow(value: unknown): Window | undefined | Error {
  if (value === undefined || value === null) return undefined;
  const bad = new Error(
    'window must look like { "from": "09:00", "to": "18:00", "timeZone": "Europe/Berlin", "days": ["mon", "tue"] }, with from before to.'
  );
  if (!isRecord(value)) return bad;
  const { from, to, timeZone, days } = value;
  const time = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (typeof from !== "string" || typeof to !== "string" || !time.test(from) || !time.test(to) || from >= to)
    return bad;
  if (typeof timeZone !== "string" || timeZone.length > 64 || !timeZoneIsValid(timeZone)) {
    return new Error("window.timeZone must be a time zone name like Europe/Berlin or America/New_York.");
  }
  if (days === undefined || days === null) return { from, to, timeZone };
  const known = (day: unknown): day is Day => DAYS.includes(day as Day);
  if (!Array.isArray(days) || days.length === 0 || !days.every(known) || new Set(days).size !== days.length) {
    return new Error("window.days must be a list of mon, tue, wed, thu, fri, sat, sun, each at most once.");
  }
  return { from, to, timeZone, days: DAYS.filter((day) => days.includes(day)) };
}

/** Turns the request body into a campaign, or says what is wrong with it. */
function parseCampaign(body: unknown, at: number): { campaign: Campaign } | { problem: string } {
  if (!isRecord(body)) return { problem: "Send a JSON object with a calls list." };
  const failure = (error: Error) => ({ problem: error.message });

  if (!Array.isArray(body.calls) || body.calls.length === 0 || body.calls.length > MAX_CALLS) {
    return { problem: `calls must be a list of 1 to ${MAX_CALLS} items like { "to": "+14155550123" }.` };
  }
  const name = optionalText(body.name, 120, "name");
  const context = optionalText(body.context, MAX_CONTEXT_CHARS, "context");
  const voicemailMessage = optionalText(body.voicemailMessage, MAX_VOICEMAIL_CHARS, "voicemailMessage");
  for (const value of [name, context, voicemailMessage]) if (value instanceof Error) return failure(value);
  const campaignName = name as string | undefined;
  const campaignContext = context as string | undefined;
  const campaignVoicemail = voicemailMessage as string | undefined;
  const concurrency = optionalInteger(body.concurrency, 1, 50, 1, "concurrency");
  const attempts = optionalInteger(body.attempts, 1, 5, 1, "attempts");
  const retryAfterMinutes = optionalInteger(body.retryAfterMinutes, 1, 1440, 30, "retryAfterMinutes");
  for (const value of [concurrency, attempts, retryAfterMinutes]) if (value instanceof Error) return failure(value);
  const window = parseWindow(body.window);
  if (window instanceof Error) return failure(window);

  let carrier: CampaignCarrier | undefined;
  if (body.carrier !== undefined && body.carrier !== null) {
    if (body.carrier !== "twilio" && body.carrier !== "telnyx") return { problem: "carrier must be twilio or telnyx." };
    carrier = body.carrier;
  }

  let startAt: string | undefined;
  if (body.startAt !== undefined && body.startAt !== null) {
    const parsed =
      typeof body.startAt === "string" && /^\d{4}-\d{2}-\d{2}T/.test(body.startAt) ? Date.parse(body.startAt) : NaN;
    if (Number.isNaN(parsed)) return { problem: "startAt must be a time like 2026-12-01T09:00:00Z." };
    if (parsed > at + MAX_START_AHEAD_MS) return { problem: "startAt can be at most 30 days ahead." };
    startAt = new Date(parsed).toISOString();
  }

  const seen = new Set<string>();
  const calls: CampaignCall[] = [];
  for (const [index, item] of body.calls.entries()) {
    const where = `calls[${index}]`;
    if (!isRecord(item)) return { problem: `${where} must be an object like { "to": "+14155550123" }.` };
    const to = typeof item.to === "string" ? item.to.trim() : "";
    if (!E164.test(to)) return { problem: `${where}.to must be a phone number in E.164 form, like +14155550123.` };
    if (seen.has(to)) return { problem: `${where}.to is already in the list. A number may appear only once.` };
    seen.add(to);
    const own = [
      optionalText(item.context, MAX_CONTEXT_CHARS, `${where}.context`),
      optionalText(item.userId, 128, `${where}.userId`),
      optionalText(item.voicemailMessage, MAX_VOICEMAIL_CHARS, `${where}.voicemailMessage`)
    ];
    for (const value of own) if (value instanceof Error) return failure(value);
    const [callContext, userId, callVoicemail] = own as [string?, string?, string?];
    calls.push({
      to,
      ...(callContext ? { context: callContext } : {}),
      ...(userId ? { userId } : {}),
      ...(callVoicemail ? { voicemailMessage: callVoicemail } : {}),
      status: "waiting",
      attempts: 0
    });
  }

  return {
    campaign: {
      id: randomUUID(),
      ...(campaignName ? { name: campaignName } : {}),
      ...(carrier ? { carrier } : {}),
      concurrency: concurrency as number,
      attempts: attempts as number,
      retryAfterMinutes: retryAfterMinutes as number,
      ...(window ? { window } : {}),
      ...(startAt ? { startAt } : {}),
      ...(campaignContext ? { context: campaignContext } : {}),
      ...(campaignVoicemail ? { voicemailMessage: campaignVoicemail } : {}),
      createdAt: new Date(at).toISOString(),
      cancelled: false,
      calls
    }
  };
}

const inProgress = (call: CampaignCall): boolean => call.status === "calling" || call.status === "answered";

const countIn = (campaign: Campaign, ...statuses: CallStatus[]): number =>
  campaign.calls.filter((call) => statuses.includes(call.status)).length;

/** Reads what a saved file holds, or says it is not a campaigns file. */
function reviveCampaigns(raw: unknown): Campaign[] | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.campaigns)) return undefined;
  const revived: Campaign[] = [];
  for (const item of raw.campaigns as unknown[]) {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.createdAt !== "string") return undefined;
    if (!Array.isArray(item.calls) || typeof item.concurrency !== "number" || typeof item.attempts !== "number") {
      return undefined;
    }
    for (const call of item.calls as unknown[]) {
      if (!isRecord(call) || typeof call.to !== "string" || typeof call.attempts !== "number") return undefined;
      if (!CALL_STATUSES.includes(call.status as CallStatus)) return undefined;
    }
    revived.push(item as unknown as Campaign);
  }
  return revived;
}

export function createCampaigns(options: CampaignOptions): Campaigns {
  const { log } = options;
  const now = options.now ?? Date.now;
  let campaigns: Campaign[] = [];
  let loadProblem: string | undefined;
  /** A file that could not be read is left alone until a campaign is created. */
  let saveBlocked = false;

  // Placement: one at a time, with a gap, and never while the relay's lines are full.
  let placing = false;
  let lastPlacedAt = Number.NEGATIVE_INFINITY;
  let linesBusyUntil = 0;
  let wakeTimer: NodeJS.Timeout | undefined;
  let wakeAt = 0;
  let closed = false;

  // Persistence.
  let dirty = false;
  let saveTimer: NodeJS.Timeout | undefined;
  let lastSavedAt = Number.NEGATIVE_INFINITY;
  let writing: Promise<void> = Promise.resolve();

  const formatters = new Map<string, Intl.DateTimeFormat>();

  function statusOf(campaign: Campaign, at: number): CampaignStatus {
    if (campaign.cancelled) return "cancelled";
    if (!campaign.calls.some((call) => call.status === "waiting" || inProgress(call))) return "done";
    return campaign.startAt && at < Date.parse(campaign.startAt) ? "scheduled" : "running";
  }

  /** Whether the campaign's window is open at `at`. A campaign without one is always open. */
  function windowOpen(campaign: Campaign, at: number): boolean {
    const window = campaign.window;
    if (!window) return true;
    let formatter = formatters.get(window.timeZone);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: window.timeZone,
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
      });
      formatters.set(window.timeZone, formatter);
    }
    const parts = Object.fromEntries(formatter.formatToParts(new Date(at)).map((part) => [part.type, part.value]));
    const day = String(parts.weekday).slice(0, 3).toLowerCase();
    if (window.days && !window.days.includes(day as Day)) return false;
    const local = `${String(parts.hour).padStart(2, "0")}:${parts.minute}`;
    return local >= window.from && local < window.to;
  }

  function summarise(campaign: Campaign, at: number): CampaignSummary {
    const status = statusOf(campaign, at);
    const counts = Object.fromEntries(CALL_STATUSES.map((name) => [name, countIn(campaign, name)])) as Record<
      CallStatus,
      number
    >;
    return {
      id: campaign.id,
      ...(campaign.name ? { name: campaign.name } : {}),
      ...(campaign.carrier ? { carrier: campaign.carrier } : {}),
      status,
      createdAt: campaign.createdAt,
      ...(campaign.startAt ? { startAt: campaign.startAt } : {}),
      concurrency: campaign.concurrency,
      attempts: campaign.attempts,
      retryAfterMinutes: campaign.retryAfterMinutes,
      ...(campaign.window ? { window: campaign.window } : {}),
      waitingForWindow: status === "running" && counts.waiting > 0 && !windowOpen(campaign, at),
      total: campaign.calls.length,
      counts
    };
  }

  // --- persistence ---------------------------------------------------------

  async function writeFileNow(): Promise<void> {
    const file = options.file;
    if (!file || saveBlocked || !dirty) return;
    dirty = false;
    lastSavedAt = now();
    const state = JSON.stringify({ version: 1, campaigns });
    const temporary = `${file}.tmp`;
    try {
      await writeFile(temporary, state, { mode: 0o600 });
      await rename(temporary, file);
    } catch (error) {
      dirty = true;
      log.warn("campaigns could not be saved", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Saves what changed, not more often than every second. */
  function changed(): void {
    dropOldFinished();
    if (!options.file) return;
    dirty = true;
    if (saveTimer || closed) return;
    const wait = Math.max(0, lastSavedAt + SAVE_GAP_MS - now());
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      writing = writing.then(writeFileNow);
    }, wait);
    saveTimer.unref?.();
  }

  function load(): void {
    const file = options.file;
    if (!file) return;
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      loadProblem = `CAMPAIGNS_FILE could not be read (${(error as NodeJS.ErrnoException).code ?? "error"}). It is left as it is until a campaign is created.`;
      saveBlocked = true;
      return;
    }
    let revived: Campaign[] | undefined;
    try {
      revived = reviveCampaigns(JSON.parse(text));
    } catch {
      revived = undefined;
    }
    if (!revived) {
      loadProblem =
        "CAMPAIGNS_FILE is not a campaigns file, so no campaigns were loaded. It is left as it is until a campaign is created.";
      saveBlocked = true;
      return;
    }
    // A call that was on the line when the relay stopped is not dialled again: the person may have been spoken to.
    for (const campaign of revived) {
      for (const call of campaign.calls) {
        if (!inProgress(call)) continue;
        call.status = "unknown";
        call.endedReason = RESTART_REASON;
      }
    }
    campaigns = revived;
  }

  // --- placing -------------------------------------------------------------

  function wake(delay: number): void {
    if (closed) return;
    const due = now() + delay;
    if (wakeTimer && wakeAt <= due) return;
    clearTimeout(wakeTimer);
    wakeAt = due;
    wakeTimer = setTimeout(() => {
      wakeTimer = undefined;
      void tick();
    }, delay);
    wakeTimer.unref?.();
  }

  /** The next call that may be placed now, and otherwise how long until something might change. */
  function nextDue(at: number): { due?: { campaign: Campaign; call: CampaignCall }; retryIn?: number } {
    let retryIn: number | undefined;
    const soonest = (ms: number): void => {
      retryIn = retryIn === undefined ? ms : Math.min(retryIn, ms);
    };
    for (const campaign of campaigns) {
      if (statusOf(campaign, at) === "scheduled") {
        soonest(Date.parse(campaign.startAt as string) - at);
        continue;
      }
      if (statusOf(campaign, at) !== "running") continue;
      if (!windowOpen(campaign, at)) {
        soonest(WINDOW_CHECK_MS);
        continue;
      }
      // A finished call wakes the scheduler, so a full campaign waits for that.
      if (campaign.calls.filter(inProgress).length >= campaign.concurrency) continue;
      for (const call of campaign.calls) {
        if (call.status !== "waiting") continue;
        if ((call.notBefore ?? 0) <= at) return { due: { campaign, call } };
        soonest((call.notBefore as number) - at);
      }
    }
    return { ...(retryIn !== undefined ? { retryIn } : {}) };
  }

  async function tick(): Promise<void> {
    if (placing || closed) return;
    const at = now();
    const { due, retryIn } = nextDue(at);
    if (!due) {
      if (retryIn !== undefined) wake(Math.max(retryIn, 0));
      return;
    }
    const wait = Math.max(lastPlacedAt + PLACE_GAP_MS - at, linesBusyUntil - at);
    if (wait > 0) {
      wake(wait);
      return;
    }
    placing = true;
    try {
      await placeOne(due.campaign, due.call);
    } finally {
      placing = false;
    }
    wake(PLACE_GAP_MS);
  }

  async function placeOne(campaign: Campaign, call: CampaignCall): Promise<void> {
    lastPlacedAt = now();
    const earlierAttempt = call.lastAttemptAt;
    call.status = "calling";
    call.attempts += 1;
    call.lastAttemptAt = new Date(lastPlacedAt).toISOString();
    delete call.notBefore;
    changed();
    const context = call.context ?? campaign.context;
    const voicemailMessage = call.voicemailMessage ?? campaign.voicemailMessage;
    let result: PlaceResult;
    try {
      result = await options.place(
        campaign.carrier,
        {
          to: call.to,
          ...(context ? { context } : {}),
          ...(call.userId ? { userId: call.userId } : {}),
          ...(voicemailMessage ? { voicemailMessage } : {})
        },
        (progress) => onProgress(campaign, call, progress),
        campaign.origin
      );
    } catch {
      result = { ok: false, status: 500, error: "The call could not be placed." };
    }
    if (result.ok) {
      // The first event may have come before this answer: keep what it set.
      if (call.callSid === undefined && result.callSid) call.callSid = result.callSid;
    } else if (result.status === 429) {
      // The relay's own lines are full. That is not an attempt at this person.
      call.status = "waiting";
      call.attempts -= 1;
      if (earlierAttempt) call.lastAttemptAt = earlierAttempt;
      else delete call.lastAttemptAt;
      linesBusyUntil = now() + LINE_BUSY_RETRY_MS;
    } else {
      call.status = "failed";
      call.endedReason = result.error;
    }
    changed();
  }

  function onProgress(campaign: Campaign, call: CampaignCall, progress: CallProgress): void {
    // Events for a call that is already settled (or never placed) change nothing.
    if (!inProgress(call)) return;
    if (progress.type === "answered") {
      call.status = "answered";
      call.callSid = progress.callSid;
    } else if (progress.type === "ended") {
      call.status = "completed";
      call.callSid = progress.callSid;
      call.durationMs = progress.durationMs;
      call.endedReason = progress.reason;
    } else if (progress.type === "machine") {
      call.status = "voicemail";
      call.callSid = progress.callSid;
      call.answeredBy = progress.answeredBy;
    } else if (progress.type === "unanswered") {
      if (progress.callSid) call.callSid = progress.callSid;
      if (progress.status === "busy" || progress.status === "no-answer") {
        call.status = progress.status;
        // Another try later, unless the campaign has been stopped or the tries are used up.
        if (!campaign.cancelled && call.attempts < campaign.attempts) {
          call.notBefore = now() + campaign.retryAfterMinutes * 60_000;
          call.status = "waiting";
        }
      } else {
        call.status = "failed";
        call.endedReason =
          progress.status === "canceled" ? "the carrier canceled the call" : "the carrier could not complete the call";
      }
    } else {
      call.status = "unknown";
      call.endedReason = "the carrier did not say what became of the call";
    }
    changed();
    wake(0);
  }

  // --- the API -------------------------------------------------------------

  function create(body: unknown, origin?: string): Created {
    const at = now();
    const parsed = parseCampaign(body, at);
    if ("problem" in parsed) return { ok: false, status: 400, problem: parsed.problem };
    const active = campaigns.filter((campaign) => {
      const status = statusOf(campaign, at);
      return status === "scheduled" || status === "running";
    });
    if (active.length >= MAX_ACTIVE_CAMPAIGNS) {
      return {
        ok: false,
        status: 409,
        problem: `At most ${MAX_ACTIVE_CAMPAIGNS} campaigns can be scheduled or running at once. Wait for one to finish, or cancel one.`
      };
    }
    const notReady = options.notReady?.(parsed.campaign.carrier);
    if (notReady) return { ok: false, status: 503, problem: notReady };

    if (origin) parsed.campaign.origin = origin;
    campaigns.push(parsed.campaign);
    saveBlocked = false;
    log.info("campaign created", { campaignId: parsed.campaign.id, calls: parsed.campaign.calls.length });
    changed();
    wake(0);
    return { ok: true, campaign: summarise(parsed.campaign, at) };
  }

  /** Finished campaigns are kept up to a limit, oldest dropped first. */
  function dropOldFinished(): void {
    const at = now();
    const finished = campaigns.filter((campaign) => isFinished(campaign, at));
    const surplus = new Set(finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_CAMPAIGNS)));
    if (surplus.size > 0) campaigns = campaigns.filter((campaign) => !surplus.has(campaign));
  }

  /** Done or cancelled, with nobody on the line. */
  function isFinished(campaign: Campaign, at: number): boolean {
    const status = statusOf(campaign, at);
    return (status === "done" || status === "cancelled") && !campaign.calls.some(inProgress);
  }

  function list(): CampaignSummary[] {
    const at = now();
    return campaigns.map((campaign) => summarise(campaign, at)).reverse();
  }

  function get(id: string): CampaignDetail | undefined {
    const campaign = campaigns.find((other) => other.id === id);
    if (!campaign) return undefined;
    return {
      ...summarise(campaign, now()),
      calls: campaign.calls.map((call) => ({
        to: call.to,
        status: call.status,
        attempts: call.attempts,
        ...(call.callSid ? { callSid: call.callSid } : {}),
        ...(call.durationMs !== undefined ? { durationMs: call.durationMs } : {}),
        ...(call.endedReason ? { endedReason: call.endedReason } : {}),
        ...(call.answeredBy ? { answeredBy: call.answeredBy } : {}),
        ...(call.lastAttemptAt ? { lastAttemptAt: call.lastAttemptAt } : {})
      }))
    };
  }

  function cancel(id: string): CampaignSummary | undefined {
    const campaign = campaigns.find((other) => other.id === id);
    if (!campaign) return undefined;
    // Calls on the line finish and keep their real outcome; the rest are not placed.
    if (!campaign.cancelled && statusOf(campaign, now()) !== "done") {
      campaign.cancelled = true;
      for (const call of campaign.calls) if (call.status === "waiting") call.status = "cancelled";
      log.info("campaign cancelled", { campaignId: id });
      changed();
    }
    return summarise(campaign, now());
  }

  function remove(id: string): { ok: true } | { ok: false; status: number; problem: string } {
    const campaign = campaigns.find((other) => other.id === id);
    if (!campaign) return { ok: false, status: 404, problem: "There is no such campaign." };
    if (!isFinished(campaign, now())) {
      return {
        ok: false,
        status: 409,
        problem: "Cancel the campaign and wait for its calls to end before deleting it."
      };
    }
    campaigns = campaigns.filter((other) => other !== campaign);
    changed();
    return { ok: true };
  }

  async function close(): Promise<void> {
    closed = true;
    clearTimeout(wakeTimer);
    clearTimeout(saveTimer);
    saveTimer = undefined;
    writing = writing.then(writeFileNow);
    await writing;
  }

  load();
  if (loadProblem) log.warn(loadProblem);
  wake(0);

  return {
    create,
    list,
    get,
    cancel,
    remove,
    get loadProblem() {
      return loadProblem;
    },
    close
  };
}
