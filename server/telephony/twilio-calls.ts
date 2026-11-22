import { randomBytes } from "node:crypto";
import type { Logger } from "../logger";
import type { ToolDefinition } from "../tools";
import type { Carrier, CarrierBridge } from "./carrier";
import {
  dialTwiml,
  DtmfCollector,
  EMPTY_TWIML,
  hangupTwiml,
  parseTwilioMessage,
  streamTwiml,
  TwilioAudioBridge,
  validTwilioSignature,
  warmDialTwiml,
  whisperTwiml
} from "./twilio-stream";

/**
 * Phone calls. The call logic here is the same for every carrier; what differs
 * between carriers is behind {@link Carrier} (carrier.ts). Twilio is the
 * default one and is defined in this file; Telnyx is in telnyx.ts.
 *
 * A call reaches the assistant exactly as a web session does: the media stream is adapted to the relay's own `/agent`
 * protocol, so every backend, tool and conversation setting works on the phone
 * with nothing phone-specific in between.
 *
 *   caller ── PSTN ── Twilio ──POST /telephony/twilio/voice──▶ relay (TwiML: connect a stream)
 *                        └─────WS  /telephony/twilio/stream──▶ relay (μ-law 8 kHz both ways)
 *
 * Who may open a stream: Twilio's WebSocket carries no credentials, so the
 * voice webhook (whose signature proves it is Twilio, for this account) mints
 * a single-use ticket and passes it as a stream parameter. A socket that does
 * not present a fresh ticket for its own call within a few seconds is closed.
 */

/** What the call logic needs to know, whichever carrier the calls come through. */
export type CallSettings = {
  /** The number outbound calls come from. */
  phoneNumber?: string;
  /** The relay's public origin, as the carrier reaches it. Derived from the request when absent. */
  publicUrl?: string;
  /** Where the assistant may transfer a call: name → E.164 number or sip: URI. */
  transferTargets: Map<string, string>;
  /**
   * Warm transfers: whoever picks up hears what the call is about first, and
   * the caller comes back to the assistant when nobody takes the call. With
   * "confirm" the person must also press a key to take it.
   */
  warmTransfer?: "on" | "confirm";
  /** What the carrier says after the summary when a key must be pressed. */
  transferPrompt?: string;
  maxCalls: number;
};

export type TelephonySettings = CallSettings & {
  authToken: string;
  /** Needed to transfer or place calls (the REST API), not to answer them. */
  accountSid?: string;
};

export const E164 = /^\+[1-9]\d{6,14}$/;
const SIP_URI = /^sip:[^\s<>]+$/;
const TARGET_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/;
const SID = /^[A-Za-z0-9]{1,64}$/;
const TICKET_TTL_MS = 60_000;
const OUTBOUND_TTL_MS = 5 * 60_000;
const MAX_TICKETS = 2_000;
// Twilio sends `start` as soon as the socket opens. A socket that takes longer
// is not Twilio, and holds a slot a real call needs.
const START_TIMEOUT_MS = 3_000;
/** How long a call that has connected is remembered, so its webhook cannot be replayed. */
const CALL_MEMORY_MS = 24 * 60 * 60_000;
const MAX_REMEMBERED_CALLS = 20_000;
const DRAIN_TIMEOUT_MS = 6_000;
const TRANSFER_ANNOUNCE_MS = 12_000;
/** How long a warm transfer rings before the caller goes back to the assistant. */
const TRANSFER_RING_SECONDS = 25;
/** How long a warm transfer is remembered: the ringing, the summary and the key press fit in it many times. */
const TRANSFER_MEMORY_MS = 5 * 60_000;
/**
 * How long after a warm transfer began its call is taken to be with the person
 * it went to, when the carrier has not said otherwise: the ringing, the
 * summary and the key press are over by then.
 */
const TRANSFER_SETTLE_MS = 90_000;
/** How long after the first time the summary is given to a carrier that asks again. */
const WHISPER_REPEAT_MS = 30_000;
const MAX_SUMMARY_CHARS = 400;
const MAX_TRANSFER_PROMPT_CHARS = 200;
const DEFAULT_TRANSFER_PROMPT = "Press any key to take the call.";
/** Why a transfer did not go through, as the assistant is told it. */
const TRANSFER_FAILURES: Record<string, string> = {
  busy: "the line was busy",
  "no-answer": "nobody answered",
  failed: "the call could not be placed",
  canceled: "the call was cancelled"
};
export const MAX_CONTEXT_CHARS = 2_000;
export const MAX_VOICEMAIL_CHARS = 500;
const REST_TIMEOUT_MS = 10_000;
/** How long a watched call may stay unheard of (not placed, not answered) before it is reported as unknown. */
const UNHEARD_MS = 3 * 60_000;
const MAX_WATCHED_CALLS = 2_000;

/**
 * Reads the TELEPHONY_* variables, which every carrier shares, and the
 * carrier's own number. `canTransfer` is whether the carrier's REST
 * credentials are set; `needs` names them for the message when they are not.
 */
export function callSettingsFromEnv(
  env: NodeJS.ProcessEnv,
  carrier: { numberVariable: string; canTransfer: boolean; needs: string; warmTransfers?: boolean; label?: string }
): { settings: CallSettings; problems: string[] } {
  const problems: string[] = [];
  const phoneNumber = env[carrier.numberVariable]?.trim();
  if (phoneNumber && !E164.test(phoneNumber)) {
    problems.push(`${carrier.numberVariable} must be in E.164 form, like +14155550100`);
  }
  let publicUrl: string | undefined;
  const rawPublic = env.TELEPHONY_PUBLIC_URL?.trim();
  if (rawPublic) {
    try {
      const parsed = new URL(rawPublic);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("scheme");
      publicUrl = parsed.origin;
    } catch {
      problems.push("TELEPHONY_PUBLIC_URL must be the relay's public address, like https://voice.example.com");
    }
  }
  const transferTargets = new Map<string, string>();
  for (const entry of (env.TELEPHONY_TRANSFER_NUMBERS ?? "").split(",")) {
    const item = entry.trim();
    if (!item) continue;
    const at = item.indexOf("=");
    const name = at > 0 ? item.slice(0, at).trim() : "";
    const destination = at > 0 ? item.slice(at + 1).trim() : "";
    if (!TARGET_NAME.test(name) || !(E164.test(destination) || SIP_URI.test(destination))) {
      problems.push(
        `TELEPHONY_TRANSFER_NUMBERS: ${JSON.stringify(item.slice(0, 40))} must look like support=+14155550100 or sales=sip:sales@example.com`
      );
      continue;
    }
    transferTargets.set(name, destination);
  }
  if (transferTargets.size > 0 && !carrier.canTransfer) {
    problems.push(`TELEPHONY_TRANSFER_NUMBERS needs ${carrier.needs}`);
  }
  let warmTransfer: "on" | "confirm" | undefined;
  const warm = env.TELEPHONY_WARM_TRANSFER?.trim().toLowerCase();
  if (warm && warm !== "off") {
    if (warm !== "on" && warm !== "confirm") {
      problems.push("TELEPHONY_WARM_TRANSFER must be on, confirm or off");
    } else if (!carrier.warmTransfers) {
      problems.push(
        `TELEPHONY_WARM_TRANSFER: calls through ${carrier.label ?? "this carrier"} are transferred without it. The relay does warm transfers on Twilio.`
      );
    } else if (!carrier.canTransfer) {
      problems.push(`TELEPHONY_WARM_TRANSFER needs ${carrier.needs}`);
    } else {
      warmTransfer = warm;
    }
  }
  const transferPrompt = env.TELEPHONY_TRANSFER_PROMPT?.trim().slice(0, MAX_TRANSFER_PROMPT_CHARS);
  const maxCalls = Number(env.TELEPHONY_MAX_CALLS);
  return {
    settings: {
      ...(phoneNumber && E164.test(phoneNumber) ? { phoneNumber } : {}),
      ...(publicUrl ? { publicUrl } : {}),
      transferTargets,
      ...(warmTransfer ? { warmTransfer } : {}),
      ...(warmTransfer && transferPrompt ? { transferPrompt } : {}),
      maxCalls: Number.isInteger(maxCalls) && maxCalls > 0 ? Math.min(maxCalls, 1_000) : 20
    },
    problems
  };
}

/** Reads the TWILIO_* and TELEPHONY_* variables. No settings when Twilio is not set up. */
export function telephonySettingsFromEnv(env: NodeJS.ProcessEnv = process.env): {
  settings?: TelephonySettings;
  problems: string[];
} {
  const authToken = env.TWILIO_AUTH_TOKEN?.trim();
  if (!authToken) return { problems: [] };
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim();
  const sidProblems = accountSid && !SID.test(accountSid) ? ["TWILIO_ACCOUNT_SID is not an account SID"] : [];
  const shared = callSettingsFromEnv(env, {
    numberVariable: "TWILIO_PHONE_NUMBER",
    canTransfer: Boolean(accountSid),
    needs: "TWILIO_ACCOUNT_SID: a transfer goes through Twilio's REST API",
    warmTransfers: true,
    label: "Twilio"
  });
  return {
    settings: { ...shared.settings, authToken, ...(accountSid && SID.test(accountSid) ? { accountSid } : {}) },
    problems: [...sidProblems, ...shared.problems]
  };
}

const BUSY_XML = `<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="busy"/></Response>`;

/** One POST to a carrier's REST API. Errors name a status at most: the body may quote our parameters. */
export async function carrierPost(
  request: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: string
): Promise<{ ok: boolean; status: number; body: unknown }> {
  try {
    const response = await request(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(REST_TIMEOUT_MS),
      redirect: "error"
    });
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = undefined;
    }
    return { ok: response.ok, status: response.status, body: parsed };
  } catch {
    return { ok: false, status: 0, body: undefined };
  }
}

/** Twilio: Media Streams, TwiML, and the 2010-04-01 REST API. */
function twilioCarrier(
  settings: Pick<TelephonySettings, "authToken" | "accountSid">,
  request: typeof fetch = fetch
): Carrier {
  const rest = (path: string, form: Record<string, string>) =>
    carrierPost(
      request,
      `https://api.twilio.com/2010-04-01/Accounts/${settings.accountSid}/${path}`,
      {
        authorization: `Basic ${Buffer.from(`${settings.accountSid}:${settings.authToken}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded"
      },
      new URLSearchParams(form).toString()
    );
  return {
    id: "twilio",
    label: "Twilio",
    validCallId: (id) => SID.test(id),
    authentic: (input) => validTwilioSignature(settings.authToken, input.url, input.params, input.signature),
    voiceUrl: (base, plan) => `${base}/telephony/twilio/voice?plan=${plan}`,
    voiceUrlIsSecret: false,
    statusUrl: (base, plan) => `${base}/telephony/twilio/status?plan=${plan}`,
    answerXml: (streamUrl, ticket) => streamTwiml(streamUrl, { ticket }),
    dialXml: (destination, options) => dialTwiml(destination, options),
    warmTransfer: {
      dialXml: (destination, options) => warmDialTwiml(destination, options),
      whisperXml: (text, language, confirm) => whisperTwiml(text, language, confirm),
      continueXml: () => EMPTY_TWIML
    },
    hangupXml: (say, language) => hangupTwiml(say, language),
    busyXml: () => BUSY_XML,
    parse(raw) {
      const message = parseTwilioMessage(raw);
      if (!message || message.event === "connected") return undefined;
      if (message.event !== "start") return message;
      return {
        event: "start",
        streamId: message.streamSid,
        callId: message.callSid,
        ...(message.customParameters.ticket ? { ticket: message.customParameters.ticket } : {})
      };
    },
    bridge: (streamId): CarrierBridge => new TwilioAudioBridge(streamId),
    detectsMachines: true,
    placeCallHelp: "Set TWILIO_ACCOUNT_SID and TWILIO_PHONE_NUMBER to place calls.",
    ...(settings.accountSid
      ? {
          async updateCall(callId: string, xml: string) {
            const result = await rest(`Calls/${callId}.json`, { Twiml: xml });
            return { ok: result.ok, status: result.status };
          },
          async placeCall(input: { to: string; from: string; url: string; statusUrl?: string }) {
            const result = await rest("Calls.json", {
              To: input.to,
              From: input.from,
              Url: input.url,
              Method: "POST",
              // Tells the voice webhook whether a person or a machine picked up.
              MachineDetection: "Enable",
              // Twilio's default event is the last one: completed, busy, no-answer, failed or canceled.
              ...(input.statusUrl ? { StatusCallback: input.statusUrl, StatusCallbackMethod: "POST" } : {})
            });
            const sid =
              result.body && typeof result.body === "object" ? (result.body as { sid?: unknown }).sid : undefined;
            return typeof sid === "string"
              ? { ok: result.ok, status: result.status, callId: sid }
              : { ok: false, status: result.status };
          }
        }
      : {})
  };
}

export type CallInfo = {
  callSid: string;
  direction: "inbound" | "outbound";
  from?: string;
  to?: string;
  /** Outbound calls: what the owner's backend said the call is about. */
  context?: string;
  userId?: string;
};

/** The relay's side of one call's session: what an `/agent` socket gets. */
type CallSession = {
  handleMessage(data: Buffer, isBinary: boolean): Promise<void>;
  /** The call is over. `reason` is why, when the phone side knows better than the session. */
  close(reason?: string): void;
};

/** The socket the session writes to; the same members a `ws` WebSocket has. */
export type CallClient = {
  readonly OPEN: 1;
  readyState: number;
  bufferedAmount: number;
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
};

/** The few members of a `ws` socket this module needs, so tests can stand one in. */
export type StreamSocket = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: "close" | "error", listener: () => void): unknown;
};

export type TelephonyDeps = {
  log: Logger;
  /** Starts the assistant's session for a call, or says why it cannot. */
  openSession(
    client: CallClient,
    call: CallInfo,
    extras: { sessionTools: ToolDefinition[]; trustedContext: string }
  ): CallSession | { refused: string };
  /** Language for the few lines the carrier itself speaks ("en-US"). */
  language?: string;
  request?: typeof fetch;
  now?: () => number;
};

/** A caller who is back with the assistant after a transfer nobody took. */
type Returned = { name: string; why: string; resume?: string };
type Ticket = {
  call: CallInfo;
  /** The relay's address as the carrier reached it, for the URLs a transfer gives the carrier. */
  origin: string;
  expiresAt: number;
  returned?: Returned;
};
/** A warm transfer that is under way: the carrier asks about it by a token only it was given. */
type Transfer = {
  call: CallInfo;
  origin: string;
  name: string;
  summary: string;
  /** The session's resume id: the conversation goes on from where it was if the caller comes back. */
  resume?: string;
  /** The person who picked up pressed a key. */
  accepted?: boolean;
  /** When the carrier first asked for the summary. */
  whisperedAt?: number;
  /** The ticket the caller came back with, for a carrier that asks twice. */
  ticket?: string;
  expiresAt: number;
};
type OutboundPlan = { context?: string; userId?: string; voicemailMessage?: string; expiresAt: number };

/**
 * What a caller who asked to watch a placed call is told. Exactly one of
 * `ended`, `machine`, `unanswered`, `refused` and `unknown` is the last word on a call.
 */
export type CallProgress =
  /** A person is on the line and the assistant's session is starting. */
  | { type: "answered"; callSid: string }
  /** The conversation happened and is over. */
  | { type: "ended"; callSid: string; reason: string; durationMs: number }
  /** An answering machine or a fax picked up. */
  | { type: "machine"; callSid: string; answeredBy: string; voicemailLeft: boolean }
  /** Nobody picked up, as the carrier's status callback says. */
  | { type: "unanswered"; callSid?: string; status: "busy" | "no-answer" | "failed" | "canceled" }
  /** The person picked up, but every line of the relay was taken by then: the call was hung up. */
  | { type: "refused"; callSid: string }
  /** Nothing was heard about the call in time. */
  | { type: "unknown" };

/** One call being watched, from the moment it is placed until its last word. */
type Watched = {
  plan: string;
  watch: (progress: CallProgress) => void;
  callSid?: string;
  answeredAt?: number;
  /** Its media stream is connected: the call holds one of the relay's lines. */
  onLine?: boolean;
  expiresAt: number;
  timer?: NodeJS.Timeout;
};

type PlaceCallInput = { to?: unknown; context?: unknown; userId?: unknown; voicemailMessage?: unknown };

export type Telephony = {
  /** Answers the carrier's voice webhook with XML. `url` is the full URL the carrier requested. */
  voiceWebhook(input: { url: string; params: Record<string, string>; signature: string | undefined }): {
    status: number;
    body: string;
  };
  /** Takes over a media-stream socket. `onSettled` runs once, when the socket
   *  has presented its ticket or is gone: until then it is anybody's.
   *  `urlTicket` is the ticket from the socket's own URL, on a carrier that
   *  carries it there. */
  handleStream(socket: StreamSocket, onSettled?: () => void, urlTicket?: string): void;
  /** Whether a call is waiting to open its media stream. No ticket, no socket. */
  expectsStream(): boolean;
  /**
   * Takes the carrier's status callback for an outbound call placed with a
   * `watch`. Authenticated like the voice webhook. A replay or an unknown call
   * is answered 200 and changes nothing.
   */
  statusWebhook(input: { url: string; params: Record<string, string>; signature: string | undefined }): {
    status: number;
  };
  /**
   * Answers what the carrier asks during a warm transfer: `whisper` (what the
   * person who picked up hears), `accept` (they pressed a key) and `result`
   * (the dial is over: hang up, or back to the assistant). Authenticated like
   * the voice webhook.
   */
  transferWebhook(
    kind: string,
    input: { url: string; params: Record<string, string>; signature: string | undefined }
  ): { status: number; body: string };
  /** Why calls cannot be placed through this carrier (what to set up), or nothing when they can. */
  placeProblem(): string | undefined;
  /** `watch` hears what becomes of the call, and its errors stay out of the call. */
  placeCall(
    input: PlaceCallInput,
    origin: string,
    watch?: (progress: CallProgress) => void
  ): Promise<
    | { ok: true; callSid: string }
    | {
        ok: false;
        status: number;
        error: string;
        /** With 502: what the carrier answered. 0 when it could not be reached. */
        carrierStatus?: number;
      }
  >;
  /** True when a call placed now would have a line: none is taken or spoken for by a call that is ringing. */
  hasFreeLine(): boolean;
  activeCalls(): number;
};

function rawToString(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return "";
}

/** A line a model wrote for the carrier to say: one line of plain text, not too long. */
function spokenLine(value: string): string {
  return value
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SUMMARY_CHARS);
}

function phoneOrUndefined(value: string | undefined): string | undefined {
  // Twilio also sends "anonymous", client: identities and SIP addresses here.
  return value && value.length <= 128 ? value : undefined;
}

/** A number as the assistant may be told it: digits only, never free text a caller chose. */
function dialable(value: string | undefined): string | undefined {
  return value && E164.test(value) ? value : undefined;
}

export function createTelephony(settings: TelephonySettings, deps: TelephonyDeps, carrier?: Carrier): Telephony;
export function createTelephony(settings: CallSettings, deps: TelephonyDeps, carrier: Carrier): Telephony;
export function createTelephony(
  settings: CallSettings | TelephonySettings,
  deps: TelephonyDeps,
  given?: Carrier
): Telephony {
  const now = deps.now ?? Date.now;
  const { log } = deps;
  const carrier = given ?? twilioCarrier(settings as TelephonySettings, deps.request ?? fetch);
  const tickets = new Map<string, Ticket>();
  /** The one ticket a call may hold, by CallSid. */
  const ticketOf = new Map<string, string>();
  /** Calls whose stream has connected, and until when that is remembered. */
  const connected = new Map<string, number>();
  const outbound = new Map<string, OutboundPlan>();
  /** Watched calls by plan id (the plan itself is gone once the voice webhook has used it), and by CallSid once answered. */
  const watched = new Map<string, Watched>();
  const watchedByCall = new Map<string, Watched>();
  /** Warm transfers under way, by the token in the URLs the carrier was given. */
  const transfers = new Map<string, Transfer>();
  /** How to end the stream each call on a line has, by CallSid. */
  const streams = new Map<string, (reason?: string) => void>();
  let active = 0;

  /** The last word on a watched call. Later events for it find nothing. */
  function conclude(entry: Watched, progress: CallProgress): void {
    if (watched.get(entry.plan) !== entry) return;
    watched.delete(entry.plan);
    // A call that is given up on is not answered later with nobody watching it.
    outbound.delete(entry.plan);
    if (entry.callSid && watchedByCall.get(entry.callSid) === entry) watchedByCall.delete(entry.callSid);
    clearTimeout(entry.timer);
    report(entry, progress);
  }

  function report(entry: Watched, progress: CallProgress): void {
    try {
      entry.watch(progress);
    } catch (error) {
      log.warn("a call watcher failed", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Watched calls that are placed and not yet on a line. Each will need a line
   * when it is answered, so they count against the limit when a call is placed.
   */
  function linesSpokenFor(): number {
    let count = 0;
    for (const entry of watched.values()) if (!entry.onLine) count += 1;
    return count;
  }

  /** If nothing more is heard of the call in time, it is reported as unknown. */
  function startUnheardTimer(entry: Watched): void {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => conclude(entry, { type: "unknown" }), UNHEARD_MS);
    entry.timer.unref?.();
  }

  function prune(): void {
    const at = now();
    for (const [id, ticket] of tickets) {
      if (ticket.expiresAt > at && tickets.size <= MAX_TICKETS) break;
      tickets.delete(id);
      if (ticketOf.get(ticket.call.callSid) === id) ticketOf.delete(ticket.call.callSid);
    }
    for (const [callSid, until] of connected) {
      if (until > at && connected.size <= MAX_REMEMBERED_CALLS) break;
      connected.delete(callSid);
    }
    for (const [id, plan] of outbound) {
      if (plan.expiresAt > at && outbound.size <= MAX_TICKETS) break;
      outbound.delete(id);
    }
    for (const [token, transfer] of transfers) {
      if (transfer.expiresAt > at && transfers.size <= MAX_TICKETS) break;
      transfers.delete(token);
    }
    // Watchers live for different times, so look at all of them, oldest first.
    for (const entry of [...watched.values()]) {
      if (entry.expiresAt > at && watched.size <= MAX_WATCHED_CALLS) continue;
      conclude(entry, { type: "unknown" });
    }
  }

  function voiceWebhook(input: { url: string; params: Record<string, string>; signature: string | undefined }): {
    status: number;
    body: string;
  } {
    if (!carrier.authentic(input)) return { status: 403, body: carrier.hangupXml() };
    const callSid = input.params.CallSid ?? "";
    if (!carrier.validCallId(callSid)) return { status: 400, body: carrier.hangupXml() };
    prune();
    // A webhook's proof of origin has no timestamp, so a copied request stays
    // valid. A call connects once: its webhook is worth nothing afterwards.
    if (connected.has(callSid)) {
      log.warn("telephony webhook refused: this call has already connected", { callSid });
      return { status: 200, body: carrier.hangupXml() };
    }
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      return { status: 400, body: carrier.hangupXml() };
    }
    const planId = url.searchParams.get("plan");
    const plan = planId ? outbound.get(planId) : undefined;
    const watcher = planId ? watched.get(planId) : undefined;
    if (planId) outbound.delete(planId);
    // A plan id that is unknown or expired is not an inbound call in disguise.
    if (planId && !plan) return { status: 200, body: carrier.hangupXml() };
    if (plan && carrier.detectsMachines) {
      const answeredBy = input.params.AnsweredBy ?? "";
      if (answeredBy.startsWith("machine") || answeredBy === "fax") {
        log.info("outbound call reached a machine", { callSid, answeredBy });
        if (watcher) {
          watcher.callSid = callSid;
          conclude(watcher, {
            type: "machine",
            callSid,
            answeredBy,
            voicemailLeft: answeredBy !== "fax" && Boolean(plan.voicemailMessage)
          });
        }
        return {
          status: 200,
          body: carrier.hangupXml(answeredBy === "fax" ? undefined : plan.voicemailMessage, deps.language)
        };
      }
    }
    if (active >= settings.maxCalls) {
      log.warn("call refused: every line is busy", { callSid, active });
      if (watcher && plan) {
        watcher.callSid = callSid;
        conclude(watcher, { type: "refused", callSid });
      }
      return { status: 200, body: carrier.busyXml() };
    }
    const call: CallInfo = plan
      ? {
          callSid,
          direction: "outbound",
          // On an outbound call the person is `To` and our number is `From`.
          ...(phoneOrUndefined(input.params.To) ? { to: phoneOrUndefined(input.params.To) } : {}),
          ...(phoneOrUndefined(input.params.From) ? { from: phoneOrUndefined(input.params.From) } : {}),
          ...(plan.context ? { context: plan.context } : {}),
          ...(plan.userId ? { userId: plan.userId } : {})
        }
      : {
          callSid,
          direction: "inbound",
          ...(phoneOrUndefined(input.params.From) ? { from: phoneOrUndefined(input.params.From) } : {}),
          ...(phoneOrUndefined(input.params.To) ? { to: phoneOrUndefined(input.params.To) } : {})
        };
    // The carrier asking again for the same call (a retry) gets the ticket the call
    // already holds, for what is left of its life. A new one would cancel the
    // first, and a stream that is already on its way with it would be refused.
    const earlier = ticketOf.get(callSid);
    const held = earlier ? tickets.get(earlier) : undefined;
    const ticket = earlier && held && held.expiresAt > now() ? earlier : randomBytes(24).toString("base64url");
    const origin = settings.publicUrl ?? url.origin;
    if (ticket !== earlier) {
      if (earlier) tickets.delete(earlier);
      tickets.set(ticket, { call, origin, expiresAt: now() + TICKET_TTL_MS });
      ticketOf.set(callSid, ticket);
    }
    if (watcher && plan) {
      watcher.callSid = callSid;
      watcher.answeredAt = now();
      watcher.expiresAt = now() + CALL_MEMORY_MS;
      watchedByCall.set(callSid, watcher);
      // The stream should connect within seconds; if it never does, say so.
      startUnheardTimer(watcher);
      report(watcher, { type: "answered", callSid });
    }
    return { status: 200, body: carrier.answerXml(streamUrlOf(origin), ticket) };
  }

  /** The last word on a watched call that was transferred and does not come back. */
  function transferred(callSid: string): void {
    const entry = watchedByCall.get(callSid);
    if (!entry) return;
    conclude(entry, {
      type: "ended",
      callSid,
      reason: "transfer",
      durationMs: Math.max(0, now() - (entry.answeredAt ?? now()))
    });
  }

  const streamUrlOf = (origin: string): string => `${origin.replace(/^http/, "ws")}/telephony/${carrier.id}/stream`;

  function transferWebhook(
    kind: string,
    input: { url: string; params: Record<string, string>; signature: string | undefined }
  ): { status: number; body: string } {
    if (!carrier.authentic(input)) return { status: 403, body: carrier.hangupXml() };
    const warm = carrier.warmTransfer;
    if (!warm) return { status: 404, body: carrier.hangupXml() };
    prune();
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      return { status: 400, body: carrier.hangupXml() };
    }
    const token = url.searchParams.get("t") ?? "";
    const transfer = transfers.get(token);
    if (kind === "whisper") {
      // The summary is for whoever picks up, at the moment they do. A transfer the relay no
      // longer knows of, or a request that comes long after the first, gets none.
      let summary: string | undefined;
      if (transfer) {
        transfer.whisperedAt ??= now();
        if (now() - transfer.whisperedAt <= WHISPER_REPEAT_MS) summary = transfer.summary || undefined;
      }
      // The key press is asked for either way: without it an answering machine would take the call.
      const origin = transfer?.origin ?? settings.publicUrl ?? url.origin;
      const confirm =
        settings.warmTransfer === "confirm"
          ? {
              prompt: settings.transferPrompt ?? DEFAULT_TRANSFER_PROMPT,
              actionUrl: `${origin}/telephony/${carrier.id}/transfer/accept?t=${encodeURIComponent(token)}`
            }
          : undefined;
      if (!summary && !confirm) return { status: 200, body: warm.continueXml() };
      return { status: 200, body: warm.whisperXml(summary, deps.language, confirm) };
    }
    if (kind === "accept") {
      // The carrier asks this only when a key was pressed: the two are connected next.
      if (transfer) transfer.accepted = true;
      return { status: 200, body: warm.continueXml() };
    }
    if (kind !== "result") return { status: 404, body: carrier.hangupXml() };
    const callSid = input.params.CallSid ?? "";
    // The dial is over. Without a transfer of this very call to go by, so is the call.
    if (!transfer || transfer.call.callSid !== callSid) return { status: 200, body: carrier.hangupXml() };
    if (transfer.ticket) {
      // The carrier asks again: the same answer for as long as the ticket is still to be used.
      const held = tickets.get(transfer.ticket);
      return held && held.expiresAt > now()
        ? { status: 200, body: carrier.answerXml(streamUrlOf(transfer.origin), transfer.ticket) }
        : { status: 200, body: carrier.hangupXml() };
    }
    // The dial is over, and with it the stream the call had before: its line is free for the call itself.
    streams.get(callSid)?.("transfer");
    const status = input.params.DialCallStatus ?? "";
    const talked = status === "completed" || status === "answered";
    // The carrier says whether the two were connected. If it does not, a call that was answered
    // counts, and with a key to press only one that was accepted.
    const bridged =
      input.params.DialBridged !== undefined
        ? input.params.DialBridged === "true"
        : talked && (settings.warmTransfer !== "confirm" || transfer.accepted === true);
    if (bridged || input.params.CallStatus === "completed") {
      transfers.delete(token);
      log.info("transferred call ended", { callSid, to: transfer.name });
      transferred(callSid);
      return { status: 200, body: carrier.hangupXml() };
    }
    if (active >= settings.maxCalls) {
      transfers.delete(token);
      log.warn("a caller could not come back from a transfer: every line is busy", { callSid, to: transfer.name });
      transferred(callSid);
      return { status: 200, body: carrier.hangupXml() };
    }
    const why = TRANSFER_FAILURES[status] ?? "nobody took the call";
    const ticket = randomBytes(24).toString("base64url");
    const earlier = ticketOf.get(callSid);
    if (earlier) tickets.delete(earlier);
    tickets.set(ticket, {
      call: transfer.call,
      origin: transfer.origin,
      expiresAt: now() + TICKET_TTL_MS,
      returned: { name: transfer.name, why, ...(transfer.resume ? { resume: transfer.resume } : {}) }
    });
    ticketOf.set(callSid, ticket);
    transfer.ticket = ticket;
    log.info("transfer not taken: the caller is back with the assistant", { callSid, to: transfer.name, status });
    return { status: 200, body: carrier.answerXml(streamUrlOf(transfer.origin), ticket) };
  }

  function handleStream(socket: StreamSocket, onSettled?: () => void, urlTicket?: string): void {
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      onSettled?.();
    };
    /** The session has ended on its own account (it hung up, or hit its limit). */
    let sessionDone: string | undefined;
    let session: CallSession | undefined;
    let bridge: CarrierBridge | undefined;
    let call: CallInfo | undefined;
    let closed = false;
    let counted = false;
    /** The session asked to hang up: the socket closes once Twilio has played what it holds. */
    let hangingUp = false;
    let endReason: string | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    /** The relay's address as the carrier reached it. */
    let origin: string | undefined;
    /** The session's resume id, as `session.started` gave it. */
    let resumeId: string | undefined;
    /** Where the call goes once the assistant has announced the transfer. */
    let transferTo: { name: string; destination: string; summary: string } | undefined;
    let transferTimer: NodeJS.Timeout | undefined;
    let transferSpoken = false;
    let transferring = false;
    /** The warm transfer this stream's call left with. */
    let transferToken: string | undefined;
    let chain: Promise<void> = Promise.resolve();

    const toTwilio = (message: string): void => {
      if (!closed && socket.readyState === 1) socket.send(message);
    };

    /** Session messages run one at a time, in order, like a real socket's. */
    const toSession = (data: Buffer, isBinary: boolean): void => {
      const target = session;
      if (!target) return;
      chain = chain
        .then(() => target.handleMessage(data, isBinary))
        .catch((error: unknown) => {
          log.warn("call message failed", { message: error instanceof Error ? error.message : String(error) });
        });
    };
    const sendEvent = (event: Record<string, unknown>): void => toSession(Buffer.from(JSON.stringify(event)), false);

    const finish = (reason?: string): void => {
      if (closed) return;
      closed = true;
      settle();
      clearTimeout(startTimer);
      if (drainTimer) clearTimeout(drainTimer);
      if (transferTimer) clearTimeout(transferTimer);
      dtmf.close();
      client.readyState = 3;
      if (counted) active -= 1;
      if (call && streams.get(call.callSid) === finish) streams.delete(call.callSid);
      try {
        socket.close(1000);
      } catch {
        /* already gone */
      }
      session?.close(endReason ?? reason);
      if (call) {
        log.info("call ended", { callSid: call.callSid, reason: endReason ?? reason ?? "caller" });
        const entry = watchedByCall.get(call.callSid);
        const coming = transferToken ? transfers.get(transferToken) : undefined;
        if (entry && coming && !coming.ticket) {
          // A warm transfer is under way and the caller may come back: the last word on the call
          // waits for what the carrier says of the dial, and not for long.
          const callSid = call.callSid;
          clearTimeout(entry.timer);
          entry.timer = setTimeout(() => transferred(callSid), TRANSFER_SETTLE_MS);
          entry.timer.unref?.();
        } else if (entry) {
          conclude(entry, {
            type: "ended",
            callSid: call.callSid,
            reason: endReason ?? reason ?? "caller",
            durationMs: Math.max(0, now() - (entry.answeredAt ?? now()))
          });
        }
      }
    };

    /** Lets Twilio play what it has buffered, then runs `then`. */
    const afterPlayback = (name: string, then: () => void): void => {
      if (!bridge || closed) return then();
      for (const message of bridge.flush()) toTwilio(message);
      pendingMark = { name, then };
      toTwilio(bridge.mark(name));
      if (drainTimer) clearTimeout(drainTimer);
      drainTimer = setTimeout(() => {
        const waiting = pendingMark;
        pendingMark = undefined;
        waiting?.then();
      }, DRAIN_TIMEOUT_MS);
    };
    let pendingMark: { name: string; then: () => void } | undefined;

    const hangUp = (reason: string): void => {
      if (hangingUp || closed) return;
      hangingUp = true;
      endReason = endReason ?? reason;
      // Closing the stream ends the <Connect> verb, and with nothing after it the call.
      afterPlayback("end", () => finish(reason));
    };

    const completeTransfer = (): void => {
      const target = transferTo;
      // Once the call is hanging up, its last mark belongs to the hang-up.
      if (!target || transferring || hangingUp || closed || !call) return;
      transferring = true;
      if (transferTimer) clearTimeout(transferTimer);
      const info = call;
      const callSid = call.callSid;
      afterPlayback("transfer", () => {
        const dial = settings.phoneNumber ? { callerId: settings.phoneNumber } : {};
        const warm = settings.warmTransfer && origin ? carrier.warmTransfer : undefined;
        let token: string | undefined;
        let xml: string;
        if (warm && origin) {
          token = randomBytes(24).toString("base64url");
          prune();
          transfers.set(token, {
            call: info,
            origin,
            name: target.name,
            summary: target.summary,
            ...(resumeId ? { resume: resumeId } : {}),
            expiresAt: now() + TRANSFER_MEMORY_MS
          });
          const base = `${origin}/telephony/${carrier.id}/transfer`;
          xml = warm.dialXml(target.destination, {
            ...dial,
            whisperUrl: `${base}/whisper?t=${token}`,
            actionUrl: `${base}/result?t=${token}`,
            timeoutSeconds: TRANSFER_RING_SECONDS
          });
        } else {
          xml = carrier.dialXml(target.destination, dial);
        }
        const update = carrier.updateCall?.(callSid, xml) ?? Promise.resolve({ ok: false, status: 0 });
        void update.then((result) => {
          if (result.ok) {
            log.info("call transferred", { callSid, to: target.name });
            endReason = "transfer";
            transferToken = token;
            // The carrier now stops the stream itself; do not wait for it forever.
            setTimeout(() => finish("transfer"), 3_000).unref?.();
            return;
          }
          log.warn("call transfer failed", { callSid, to: target.name, status: result.status });
          if (token) transfers.delete(token);
          transferTo = undefined;
          transferring = false;
          transferSpoken = false;
          if (sessionDone !== undefined) {
            // Nobody is left to apologise: do not leave the caller on a silent line.
            hangUp(sessionDone);
            return;
          }
          sendEvent({
            type: "text.input",
            text: "(system) The transfer did not go through. Apologise, and offer to help yourself or to try again."
          });
        });
      });
    };

    const transferTool = (): ToolDefinition[] => {
      if (settings.transferTargets.size === 0 || !carrier.updateCall) return [];
      const names = [...settings.transferTargets.keys()];
      const warm = Boolean(settings.warmTransfer && carrier.warmTransfer);
      return [
        {
          name: "transfer_call",
          description:
            "Transfer the phone call to a person or department. Use it when the caller asks for a human, or needs something only that destination can do. Only this tool transfers the call: saying that you will does not.",
          parameters: {
            type: "object",
            properties: {
              destination: { type: "string", enum: names, description: "Where to transfer the call." },
              ...(warm
                ? {
                    summary: {
                      type: "string",
                      description: `One or two short sentences for the person who takes the call: who is calling and what they need. It is read to them before they are connected${
                        deps.language
                          ? `, by a voice for the language "${deps.language}": write it in that language`
                          : ""
                      }.`
                    }
                  }
                : {})
            },
            required: warm ? ["destination", "summary"] : ["destination"]
          },
          handler: (args) => {
            const name = typeof args.destination === "string" ? args.destination.trim() : "";
            // Only the owner's list: the model never supplies a number.
            const destination = settings.transferTargets.get(name);
            if (!destination) throw new Error(`there is no transfer destination called ${name || "that"}`);
            if (transferTo) return { ok: true, note: "The transfer is already under way. Say nothing more." };
            const summary = warm && typeof args.summary === "string" ? spokenLine(args.summary) : "";
            transferTo = { name, destination, summary };
            transferSpoken = false;
            // The assistant announces it first; if it never does, transfer anyway.
            transferTimer = setTimeout(completeTransfer, TRANSFER_ANNOUNCE_MS);
            return {
              ok: true,
              note: `The call will be transferred to ${name} as soon as you stop speaking. Tell the caller in one short sentence that you are transferring them now, then say nothing more.${
                warm ? " If nobody takes the call, the caller comes back to you." : ""
              }`
            };
          }
        }
      ];
    };

    const client: CallClient = {
      OPEN: 1,
      readyState: 1,
      bufferedAmount: 0,
      send(data) {
        if (closed || !bridge) return;
        if (typeof data !== "string") {
          if (hangingUp && pendingMark) return;
          for (const message of bridge.outbound(data)) toTwilio(message);
          return;
        }
        let event: { type?: unknown; state?: unknown; reason?: unknown; message?: unknown; resume?: unknown };
        try {
          event = JSON.parse(data) as typeof event;
        } catch {
          return;
        }
        if (event.type === "status") {
          // The caller spoke over the assistant: drop what Twilio still holds.
          if (event.state === "hearing") toTwilio(bridge.clear());
          if (transferTo && !transferring) {
            if (event.state === "speaking") transferSpoken = true;
            else if (transferSpoken && (event.state === "listening" || event.state === "ready")) completeTransfer();
          }
        } else if (event.type === "session.started") {
          if (typeof event.resume === "string") resumeId = event.resume;
        } else if (event.type === "session.ended") {
          endReason = typeof event.reason === "string" ? event.reason : "agent";
        } else if (event.type === "error") {
          log.warn("call session error", { message: typeof event.message === "string" ? event.message : undefined });
        }
      },
      close(_code, reason) {
        if (closed) return;
        sessionDone = reason || "ended";
        // The session is done. A transfer in progress ends the stream itself,
        // and one that was only waiting for its announcement goes through now.
        if (transferring) return;
        if (transferTo) completeTransfer();
        else hangUp(sessionDone);
      }
    };

    const dtmf = new DtmfCollector((digits) => sendEvent({ type: "text.input", text: `(keypad) ${digits}` }));

    const startTimer = setTimeout(() => {
      if (!session) {
        log.warn("media stream closed: it never presented a ticket");
        finish("unauthorised");
      }
    }, START_TIMEOUT_MS);
    startTimer.unref?.();

    socket.on("message", (data, isBinary) => {
      if (closed || isBinary) return;
      const message = carrier.parse(rawToString(data));
      if (!message) return;
      if (message.event === "start") {
        if (session) return;
        prune();
        const presented = message.ticket ?? urlTicket ?? "";
        const ticket = tickets.get(presented);
        tickets.delete(presented);
        if (ticket && ticketOf.get(ticket.call.callSid) === presented) ticketOf.delete(ticket.call.callSid);
        // The ticket must be fresh and, where the carrier names the call, for this very call.
        const otherCall = message.callId !== undefined && ticket?.call.callSid !== message.callId;
        if (message.unusable) {
          log.warn("media stream refused", { reason: message.unusable });
          finish("unsupported");
          return;
        }
        if (!ticket || ticket.expiresAt <= now() || otherCall) {
          log.warn("media stream refused: unknown or expired ticket");
          finish("unauthorised");
          return;
        }
        if (active >= settings.maxCalls) {
          // Another call took the last line between the answer and this stream.
          const refused = watchedByCall.get(ticket.call.callSid);
          if (refused) conclude(refused, { type: "refused", callSid: ticket.call.callSid });
          finish("busy");
          return;
        }
        call = ticket.call;
        origin = ticket.origin;
        const returned = ticket.returned;
        streams.set(call.callSid, finish);
        active += 1;
        counted = true;
        connected.set(call.callSid, now() + CALL_MEMORY_MS);
        // The call is connected: its end is reported by finish, not by the timer.
        const watcher = watchedByCall.get(call.callSid);
        if (watcher) {
          clearTimeout(watcher.timer);
          watcher.onLine = true;
        }
        settle();
        bridge = carrier.bridge(message.streamId);
        const callerId = dialable(call.from);
        const facts = [
          call.direction === "inbound"
            ? `This is an incoming phone call${dialable(call.to) ? ` to ${dialable(call.to)}` : ""}.${
                callerId
                  ? ` The caller ID shows ${callerId}. Caller ID can be faked: it is never proof of who is calling, so confirm identity another way before acting on an account.`
                  : ""
              }`
            : `You placed this phone call${dialable(call.to) ? ` to ${dialable(call.to)}` : ""}. The person who answered did not expect it: say who you are and why you are calling.`,
          ...(call.context ? [call.context] : []),
          ...(returned
            ? [
                `You tried to transfer this call to ${returned.name} a moment ago, and ${returned.why}. The caller is back with you.`
              ]
            : [])
        ].join("\n");
        const opened = deps.openSession(client, call, { sessionTools: transferTool(), trustedContext: facts });
        if ("refused" in opened) {
          log.warn("call refused", { callSid: call.callSid, reason: opened.refused });
          finish(opened.refused);
          return;
        }
        session = opened;
        clearTimeout(startTimer);
        log.info("call connected", {
          callSid: call.callSid,
          direction: call.direction,
          ...(returned ? { backFrom: returned.name } : {})
        });
        // A caller who is back carries on the conversation they were in.
        sendEvent({
          type: "session.start",
          sampleRate: 16000,
          channels: 1,
          ...(returned?.resume ? { resume: returned.resume } : {})
        });
        sendEvent({ type: "audio.start" });
        if (returned) {
          sendEvent({
            type: "text.input",
            text: `(system) The transfer to ${returned.name} did not go through: ${returned.why}. Tell the caller, and offer to help yourself, to try again or to take a message.`
          });
        }
        return;
      }
      if (message.event === "problem") {
        log.warn("the carrier reported a problem with a media stream", { detail: message.detail });
        return;
      }
      if (!session || !bridge) return;
      if (message.event === "media") {
        for (const frame of bridge.inbound(message.payload, message.track, message.sequence)) toSession(frame, true);
      } else if (message.event === "dtmf") {
        dtmf.digit(message.digit);
      } else if (message.event === "mark") {
        if (pendingMark?.name === message.name) {
          const waiting = pendingMark;
          pendingMark = undefined;
          if (drainTimer) clearTimeout(drainTimer);
          waiting.then();
        }
      } else if (message.event === "stop") {
        finish("caller");
      }
    });
    socket.on("close", () => finish("caller"));
    socket.on("error", () => finish("caller"));
  }

  /** Why this carrier cannot place calls yet, or nothing when it can. */
  function placeProblem(): string | undefined {
    if (!carrier.placeCall || !settings.phoneNumber) return carrier.placeCallHelp;
    if (carrier.voiceUrlIsSecret && !settings.publicUrl) {
      return `Set TELEPHONY_PUBLIC_URL to place calls through ${carrier.label}.`;
    }
    return undefined;
  }

  async function placeCall(
    input: PlaceCallInput,
    origin: string,
    watch?: (progress: CallProgress) => void
  ): Promise<{ ok: true; callSid: string } | { ok: false; status: number; error: string; carrierStatus?: number }> {
    const notReady = placeProblem();
    if (notReady || !carrier.placeCall || !settings.phoneNumber) {
      return { ok: false, status: 503, error: notReady ?? carrier.placeCallHelp };
    }
    const to = typeof input.to === "string" ? input.to.trim() : "";
    if (!E164.test(to))
      return { ok: false, status: 400, error: "to must be a phone number in E.164 form, like +14155550100." };
    const text = (value: unknown, max: number, name: string): string | undefined | Error => {
      if (value === undefined || value === null) return undefined;
      if (typeof value !== "string" || value.length > max)
        return new Error(`${name} must be text of at most ${max} characters.`);
      return value.trim() || undefined;
    };
    const context = text(input.context, MAX_CONTEXT_CHARS, "context");
    const userId = text(input.userId, 128, "userId");
    const voicemailMessage = text(input.voicemailMessage, MAX_VOICEMAIL_CHARS, "voicemailMessage");
    for (const value of [context, userId, voicemailMessage]) {
      if (value instanceof Error) return { ok: false, status: 400, error: value.message };
    }
    if (voicemailMessage !== undefined && !carrier.detectsMachines) {
      return {
        ok: false,
        status: 400,
        error: `voicemailMessage needs answering-machine detection, which the relay does not do on ${carrier.label} yet.`
      };
    }
    prune();
    // Calls that are ringing will each need a line when they are answered.
    if (active + linesSpokenFor() >= settings.maxCalls) {
      return { ok: false, status: 429, error: "Every line is busy." };
    }
    const plan = randomBytes(24).toString("base64url");
    outbound.set(plan, {
      ...(typeof context === "string" ? { context } : {}),
      ...(typeof userId === "string" ? { userId } : {}),
      ...(typeof voicemailMessage === "string" ? { voicemailMessage } : {}),
      expiresAt: now() + OUTBOUND_TTL_MS
    });
    const base = settings.publicUrl ?? origin;
    const entry: Watched | undefined = watch ? { plan, watch, expiresAt: now() + UNHEARD_MS } : undefined;
    if (entry) {
      watched.set(plan, entry);
      startUnheardTimer(entry);
    }
    const result = await carrier.placeCall({
      to,
      from: settings.phoneNumber,
      url: carrier.voiceUrl(base, plan),
      // Only a call that is watched needs the carrier to report back.
      ...(entry ? { statusUrl: carrier.statusUrl(base, plan) } : {})
    });
    if (!result.ok) {
      // The carrier's answer was lost, but the call it placed has already been
      // heard of: it is a call, and what becomes of it is reported as for any other.
      if (entry && (entry.answeredAt || watched.get(plan) !== entry)) {
        log.warn("outbound call placed, though the carrier's answer was lost", { status: result.status });
        return { ok: true, callSid: entry.callSid ?? "" };
      }
      outbound.delete(plan);
      if (entry) {
        // The caller is told by the error; the watcher hears nothing.
        clearTimeout(entry.timer);
        watched.delete(plan);
      }
      log.warn("outbound call could not be placed", { status: result.status });
      return {
        ok: false,
        status: 502,
        carrierStatus: result.status || 0,
        error: result.status
          ? `${carrier.label} refused the call (HTTP ${result.status}).`
          : `${carrier.label} could not be reached.`
      };
    }
    // Not every carrier names the call when it accepts it.
    const callSid = result.callId ?? "";
    if (entry && !entry.callSid) entry.callSid = callSid || undefined;
    log.info("outbound call placed", { callSid });
    return { ok: true, callSid };
  }

  function statusWebhook(input: { url: string; params: Record<string, string>; signature: string | undefined }): {
    status: number;
  } {
    if (!carrier.authentic(input)) return { status: 403 };
    let planId: string | null;
    try {
      planId = new URL(input.url).searchParams.get("plan");
    } catch {
      return { status: 400 };
    }
    prune();
    const entry = planId ? watched.get(planId) : undefined;
    const outcome = input.params.CallStatus;
    // An answered call ends through its media stream; this callback is the
    // only word there will be on a call that never reached a person.
    if (
      entry &&
      !entry.answeredAt &&
      (outcome === "busy" || outcome === "no-answer" || outcome === "failed" || outcome === "canceled")
    ) {
      const callSid = input.params.CallSid;
      const known = callSid && carrier.validCallId(callSid) ? callSid : entry.callSid;
      conclude(entry, { type: "unanswered", ...(known ? { callSid: known } : {}), status: outcome });
    }
    return { status: 200 };
  }

  const expectsStream = (): boolean => {
    const at = now();
    for (const ticket of tickets.values()) if (ticket.expiresAt > at) return true;
    return false;
  };

  return {
    voiceWebhook,
    statusWebhook,
    transferWebhook,
    handleStream,
    expectsStream,
    placeCall,
    placeProblem,
    hasFreeLine: () => active + linesSpokenFor() < settings.maxCalls,
    activeCalls: () => active
  };
}
