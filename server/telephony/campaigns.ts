import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import path from "node:path";
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
  /** Why the relay stopped the campaign itself, when it did. */
  stoppedReason?: string;
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
  /** Why the relay stopped the campaign itself: call after call could not be placed. */
  stoppedReason?: string;
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

type PlaceResult = { ok: true; callSid: string } | { ok: false; status: number; error: string; carrierStatus?: number };

export type CampaignOptions = {
  /** Places one call (the relay's POST /v1/calls) and reports what becomes of it to `watch`. */
  place(
    carrier: CampaignCarrier | undefined,
    input: { to: string; context?: string; userId?: string; voicemailMessage?: string },
    watch: (progress: CallProgress) => void,
    origin: string | undefined
  ): Promise<PlaceResult>;
  /** False while every line of this carrier is taken or spoken for: placing waits, and nothing is written down. */
  lineFree?(carrier: CampaignCarrier | undefined): boolean;
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
  /** Places no more calls. Calls on the line still end and are still saved. For the start of a shutdown. */
  stop(): void;
  /** Resolves when no write to the files is under way any more. */
  settled(): Promise<void>;
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
/** A large file takes time to write: the next write waits this many times as long. */
const SAVE_COST_FACTOR = 10;
/** When a placement cannot be written down first, placing waits this long. */
const STORAGE_RETRY_MS = 30_000;
/** Timers take at most 2^31-1 ms. Nothing waits longer than this without looking again. */
const MAX_WAKE_MS = 60 * 60_000;
/** This many calls in a row that cannot be placed stop a campaign: it is the setup, not the numbers. */
const MAX_PLACE_FAILURES = 5;
/** And this many in a row that the carrier refused for whatever reason, with none placed in between. */
const MAX_REFUSALS = 10;
/** When the carrier says we are calling too fast. */
const CARRIER_BUSY_RETRY_MS = 30_000;
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

/** An ISO time that says which offset it is in, and names a day that exists. */
function instantFrom(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length > 40) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return undefined;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return undefined;
  // Date.parse turns 31 February into 3 March.
  const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (day.getUTCMonth() !== Number(match[2]) - 1 || day.getUTCDate() !== Number(match[3])) return undefined;
  return parsed;
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
    const parsed = instantFrom(body.startAt);
    if (parsed === undefined) {
      return {
        problem: "startAt must be a time with its offset, like 2026-12-01T09:00:00Z or 2026-12-01T09:00:00+01:00."
      };
    }
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

/** Why a file operation failed, without the path. */
const reasonOf = (error: unknown): string =>
  (error as NodeJS.ErrnoException | undefined)?.code ?? (error instanceof Error ? error.name : "error");

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
    if (!Number.isInteger(item.concurrency) || (item.concurrency as number) < 1) return undefined;
    if (typeof item.retryAfterMinutes !== "number" || !(item.retryAfterMinutes >= 0)) return undefined;
    // What the scheduler reads on every tick must be what a request could have set.
    if (
      item.window !== undefined &&
      (parseWindow(item.window) === undefined || parseWindow(item.window) instanceof Error)
    )
      return undefined;
    if (item.startAt !== undefined && instantFrom(item.startAt) === undefined) return undefined;
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
  let storageBusyUntil = 0;
  let wakeTimer: NodeJS.Timeout | undefined;
  let wakeAt = 0;
  let stopped = false;
  let closed = false;
  /** Calls in a row that could not be placed, by campaign: for a reason that holds for every call, and for any reason. */
  const placeFailures = new WeakMap<Campaign, { everyCall: number; any: number }>();
  /** Campaigns the file holds. A campaign's calls are placed only once it is one of them. */
  const onDisk = new WeakSet<Campaign>();

  // Persistence: the whole state in the file, now and then, and one line in a
  // journal beside it before each call is placed. The journal is what makes
  // sure that a number is not dialled again after a crash; the file is everything else.
  let dirty = false;
  let saveTimer: NodeJS.Timeout | undefined;
  let lastSavedAt = Number.NEGATIVE_INFINITY;
  let saveGap = SAVE_GAP_MS;
  /** Everything that touches the two files, one after the other. */
  let writing: Promise<void> = Promise.resolve();
  /** A call is being written to the journal, and what follows from that is being decided. */
  let recording: Promise<boolean> | undefined;
  /** The number of the last line written to the journal. The file says up to which line it knows. */
  let journalSeq = 0;
  const journalFile = options.file ? `${options.file}.journal` : undefined;
  /** The journal's place in its directory is known to be on disk. */
  let journalSynced = false;

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
      ...(campaign.stoppedReason ? { stoppedReason: campaign.stoppedReason } : {}),
      total: campaign.calls.length,
      counts
    };
  }

  // --- persistence ---------------------------------------------------------

  async function writeFileNow(): Promise<void> {
    const file = options.file;
    if (!file || saveBlocked || !dirty) return;
    dirty = false;
    const started = now();
    lastSavedAt = started;
    // What may still change is taken as it is at this moment. A finished
    // campaign does not change any more, so it is turned into text only when
    // its turn comes: a long history is never one long pause.
    const seq = journalSeq;
    const written = [...campaigns];
    const snapshot = written.map((campaign) => (isFinished(campaign, started) ? campaign : JSON.stringify(campaign)));
    const temporary = `${file}.tmp`;
    try {
      const handle = await open(temporary, "w", 0o600);
      try {
        await handle.write(`{"version":1,"journalSeq":${seq},"campaigns":[`);
        for (const [index, item] of snapshot.entries()) {
          await handle.write(`${index ? "," : ""}${typeof item === "string" ? item : JSON.stringify(item)}`);
        }
        await handle.write("]}");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, file);
      // The new file is in its place for good before the journal it replaces goes.
      await syncDirectory(file);
      // Nothing was placed meanwhile: the file knows all the journal does.
      if (journalFile && seq === journalSeq) {
        await rm(journalFile, { force: true });
        journalSynced = false;
      }
      let fresh = false;
      for (const campaign of written) {
        fresh ||= !onDisk.has(campaign);
        onDisk.add(campaign);
      }
      // A campaign waits for this before its first call.
      if (fresh) wake(0);
    } catch (error) {
      dirty = true;
      log.warn("campaigns could not be saved", { reason: reasonOf(error) });
    }
    saveGap = Math.max(SAVE_GAP_MS, (now() - started) * SAVE_COST_FACTOR);
  }

  /** Makes a new or renamed file's place in its directory last through a power cut. */
  async function syncDirectory(file: string): Promise<void> {
    try {
      const handle = await open(path.dirname(file), "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      /* not every system lets a directory be synced */
    }
  }

  /** One line of the journal, written and synced. Throws when it cannot be. */
  async function appendToJournal(entry: Record<string, unknown>): Promise<void> {
    const handle = await open(journalFile as string, "a", 0o600);
    try {
      // A line of its own even after one that a crash cut short.
      await handle.appendFile(`\n${JSON.stringify(entry)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (!journalSynced) {
      await syncDirectory(journalFile as string);
      journalSynced = true;
    }
  }

  /**
   * Writes down that a call is about to be placed, and waits until it is on
   * disk. False when it could not be written: the call is then not placed,
   * because nothing would keep it from being placed again after a crash.
   */
  function recordAttempt(campaign: Campaign, call: CampaignCall, seq: number): Promise<boolean> {
    if (!journalFile) return Promise.resolve(true);
    const entry = { seq, campaign: campaign.id, to: call.to, attempts: call.attempts, at: call.lastAttemptAt };
    const written = writing.then(async () => {
      try {
        await appendToJournal(entry);
        return true;
      } catch (error) {
        log.warn("a call was not placed: it could not be written to the campaigns journal first", {
          reason: reasonOf(error)
        });
        return false;
      }
    });
    writing = written.then(() => undefined);
    return written;
  }

  /**
   * Takes a line of the journal back: the call it announced was not placed
   * after all. Not waited for; if it is lost, the call counts as placed.
   */
  function recordUndo(seq: number): void {
    if (!journalFile) return;
    writing = writing.then(() => appendToJournal({ undo: seq })).catch(() => undefined);
  }

  /** Writes the file now, whatever was written when. For what must not wait: a new campaign. */
  function saveNow(): void {
    if (!options.file || closed) return;
    dirty = true;
    clearTimeout(saveTimer);
    saveTimer = undefined;
    lastSavedAt = now();
    writing = writing.then(writeFileNow);
  }

  /** Saves what changed, not more often than every second. */
  function changed(): void {
    dropOldFinished();
    if (!options.file) return;
    dirty = true;
    if (saveTimer || closed) return;
    const wait = Math.max(0, lastSavedAt + saveGap - now());
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      // Counted from now, not from when the write gets its turn behind the journal.
      lastSavedAt = now();
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
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // Lines left by campaigns that are gone: new lines are numbered after them.
        replayJournal(0);
        return;
      }
      loadProblem = `CAMPAIGNS_FILE could not be read (${(error as NodeJS.ErrnoException).code ?? "error"}). It is left as it is until a campaign is created.`;
      saveBlocked = true;
      return;
    }
    let revived: Campaign[] | undefined;
    let parsedFile: unknown;
    try {
      parsedFile = JSON.parse(text);
      revived = reviveCampaigns(parsedFile);
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
    for (const campaign of revived) onDisk.add(campaign);
    const known =
      isRecord(parsedFile) && Number.isInteger(parsedFile.journalSeq) ? (parsedFile.journalSeq as number) : 0;
    journalSeq = known;
    replayJournal(known);
  }

  /** Calls the journal says were placed after the file was last written: they are not placed again either. */
  function replayJournal(known: number): void {
    if (!journalFile) return;
    let text: string;
    try {
      text = readFileSync(journalFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      // Without the journal nobody knows which calls were placed last. Place none.
      loadProblem = `The campaigns journal could not be read (${reasonOf(error)}), so the campaigns in CAMPAIGNS_FILE were cancelled: some of their calls may already have been placed.`;
      for (const campaign of campaigns) {
        if (campaign.cancelled || !campaign.calls.some((call) => call.status === "waiting")) continue;
        campaign.cancelled = true;
        campaign.stoppedReason = "The campaigns journal could not be read after a restart.";
        for (const call of campaign.calls) if (call.status === "waiting") call.status = "cancelled";
      }
      dirty = true;
      return;
    }
    let applied = 0;
    const entries: Record<string, unknown>[] = [];
    const undone = new Set<number>();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry: unknown = JSON.parse(line);
        if (!isRecord(entry)) continue;
        if (typeof entry.undo === "number") {
          undone.add(entry.undo);
          // Its number is not given to another line: a late "undo" must never take back a later call.
          journalSeq = Math.max(journalSeq, entry.undo);
        } else entries.push(entry);
      } catch {
        // A line cut short by the crash: its call was not placed, the line comes first.
      }
    }
    for (const entry of entries) {
      if (typeof entry.seq !== "number" || typeof entry.attempts !== "number") continue;
      journalSeq = Math.max(journalSeq, entry.seq);
      if (entry.seq <= known || undone.has(entry.seq)) continue;
      const call = campaigns
        .find((campaign) => campaign.id === entry.campaign)
        ?.calls.find((other) => other.to === entry.to);
      if (!call) continue;
      call.attempts = Math.max(call.attempts, entry.attempts);
      if (typeof entry.at === "string") call.lastAttemptAt = entry.at;
      delete call.notBefore;
      call.status = "unknown";
      call.endedReason = RESTART_REASON;
      applied += 1;
    }
    if (applied > 0) {
      dirty = true;
      log.warn("calls placed just before the relay stopped are not placed again", { calls: applied });
    }
  }

  // --- placing -------------------------------------------------------------

  function wake(wanted: number): void {
    if (closed || stopped) return;
    const delay = Math.min(Math.max(wanted, 0), MAX_WAKE_MS);
    const due = now() + delay;
    if (wakeTimer && wakeAt <= due) return;
    clearTimeout(wakeTimer);
    wakeAt = due;
    wakeTimer = setTimeout(() => {
      wakeTimer = undefined;
      tick().catch((error: unknown) => {
        // One campaign that cannot be read must not take the relay down with it.
        log.error("the campaign scheduler failed", { reason: reasonOf(error) });
        placing = false;
        wake(WINDOW_CHECK_MS);
      });
    }, delay);
    wakeTimer.unref?.();
  }

  /** The next call that may be placed now, and otherwise how long until something might change. */
  function nextDue(at: number): {
    due?: { campaign: Campaign; call: CampaignCall };
    retryIn?: number;
    unsaved?: boolean;
  } {
    let retryIn: number | undefined;
    let unsaved = false;
    const soonest = (ms: number): void => {
      retryIn = retryIn === undefined ? ms : Math.min(retryIn, ms);
    };
    // A number that is being called for one campaign is not called for another at the same time.
    const onTheLine = new Set<string>();
    for (const campaign of campaigns) {
      for (const call of campaign.calls) if (inProgress(call)) onTheLine.add(call.to);
    }
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
      // Not before the file holds the campaign: a crash must not leave calls that
      // were placed for a campaign nobody knows of. The write that does it wakes the scheduler.
      if (options.file && !onDisk.has(campaign)) {
        unsaved = true;
        soonest(STORAGE_RETRY_MS);
        continue;
      }
      // A finished call wakes the scheduler, so a full campaign waits for that.
      if (campaign.calls.filter(inProgress).length >= campaign.concurrency) continue;
      for (const call of campaign.calls) {
        if (call.status !== "waiting") continue;
        // The call that ends wakes the scheduler.
        if (onTheLine.has(call.to)) continue;
        if ((call.notBefore ?? 0) <= at) return { due: { campaign, call } };
        soonest((call.notBefore as number) - at);
      }
    }
    return { ...(retryIn !== undefined ? { retryIn } : {}), ...(unsaved ? { unsaved } : {}) };
  }

  async function tick(): Promise<void> {
    if (placing || closed || stopped) return;
    const at = now();
    const { due, retryIn, unsaved } = nextDue(at);
    // A write that failed is tried again.
    if (unsaved) changed();
    if (!due) {
      if (retryIn !== undefined) wake(Math.max(retryIn, 0));
      return;
    }
    // Asked before anything is written down: a full relay is not a call that was tried.
    if (linesBusyUntil <= at && options.lineFree?.(due.campaign.carrier) === false) {
      linesBusyUntil = at + LINE_BUSY_RETRY_MS;
    }
    const wait = Math.max(lastPlacedAt + PLACE_GAP_MS - at, linesBusyUntil - at, storageBusyUntil - at);
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
    const earlierNotBefore = call.notBefore;
    delete call.notBefore;
    journalSeq += 1;
    const seq = journalSeq;
    const backOut = (): void => {
      call.status = campaign.cancelled ? "cancelled" : "waiting";
      call.attempts -= 1;
      if (earlierAttempt) call.lastAttemptAt = earlierAttempt;
      else delete call.lastAttemptAt;
      if (earlierNotBefore !== undefined && !campaign.cancelled) call.notBefore = earlierNotBefore;
    };
    // On disk before the carrier hears of it: a crash right after must not lead to a second call.
    const recorded = recordAttempt(campaign, call, seq).then((written) => {
      if (!written) {
        backOut();
        storageBusyUntil = now() + STORAGE_RETRY_MS;
        return false;
      }
      // The relay began to shut down while that was written: nobody would be there to answer.
      if (stopped || closed) {
        backOut();
        recordUndo(seq);
        changed();
        return false;
      }
      return true;
    });
    // `close` waits for this, so that what it writes last is what was decided here.
    recording = recorded;
    const go = await recorded;
    if (recording === recorded) recording = undefined;
    if (!go) return;
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
      placeFailures.delete(campaign);
    } else if (call.status !== "calling") {
      // The call was heard of before the error was: it is a call, and its events say what became of it.
    } else if (result.status === 429) {
      // The relay's own lines are full. That is not an attempt at this person.
      backOut();
      recordUndo(seq);
      linesBusyUntil = now() + LINE_BUSY_RETRY_MS;
    } else {
      const carrier = result.carrierStatus;
      if (result.status === 502 && carrier === 429) {
        // The carrier says we call too fast. It placed nothing: the number is tried again later.
        backOut();
        recordUndo(seq);
        linesBusyUntil = now() + CARRIER_BUSY_RETRY_MS;
      } else {
        call.status = "failed";
        call.endedReason = result.error;
      }
      // A number the carrier will not call says nothing about the next one. A
      // carrier that cannot be reached, or will not have us, says the same for
      // all. So does one that refuses number after number without taking any.
      const everyCall =
        result.status !== 502 ||
        carrier === undefined ||
        carrier === 0 ||
        carrier >= 500 ||
        [401, 403, 429].includes(carrier);
      const earlier = placeFailures.get(campaign) ?? { everyCall: 0, any: 0 };
      const failures = { everyCall: everyCall ? earlier.everyCall + 1 : 0, any: earlier.any + 1 };
      placeFailures.set(campaign, failures);
      const count =
        failures.everyCall >= MAX_PLACE_FAILURES ? failures.everyCall : failures.any >= MAX_REFUSALS ? failures.any : 0;
      if (count > 0 && !campaign.cancelled) {
        campaign.cancelled = true;
        campaign.stoppedReason = `Stopped: ${count} calls in a row could not be placed. The last answer was: ${result.error}`;
        for (const other of campaign.calls) if (other.status === "waiting") other.status = "cancelled";
        log.warn("campaign stopped: calls cannot be placed", { campaignId: campaign.id });
      }
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
    } else if (progress.type === "refused") {
      // The person picked up and was hung up on, because other calls had taken
      // every line. That was a try; another follows if the campaign has one left.
      call.callSid = progress.callSid;
      call.status = "failed";
      call.endedReason = "every line of the relay was busy when the call was answered";
      if (!campaign.cancelled && call.attempts < campaign.attempts) {
        call.notBefore = now() + campaign.retryAfterMinutes * 60_000;
        call.status = "waiting";
        delete call.endedReason;
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
    dropOldFinished();
    // At once: its first call waits for the file to hold it.
    saveNow();
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

  /** Resolves when no write to the files is under way any more. */
  async function settled(): Promise<void> {
    let seen: Promise<void>;
    do {
      seen = writing;
      await seen;
      // What waited for that write may queue another: give it its turn first.
      await Promise.resolve();
    } while (seen !== writing);
  }

  function stop(): void {
    stopped = true;
    clearTimeout(wakeTimer);
    wakeTimer = undefined;
  }

  async function close(): Promise<void> {
    closed = true;
    clearTimeout(wakeTimer);
    clearTimeout(saveTimer);
    saveTimer = undefined;
    // A placement that was being written down when this was called backs out
    // and says so in the journal: wait for that too, and write what it changed.
    await recording;
    for (let round = 0; round < 3; round += 1) {
      writing = writing.then(writeFileNow);
      await settled();
      if (!dirty) break;
    }
  }

  load();
  if (loadProblem) log.warn(loadProblem);
  // What the journal added is written into the file at once.
  if (dirty) writing = writing.then(writeFileNow);
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
    stop,
    settled,
    close
  };
}
