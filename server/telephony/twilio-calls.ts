import { randomBytes } from "node:crypto";
import type { Logger } from "../logger";
import type { ToolDefinition } from "../tools";
import {
  dialTwiml,
  DtmfCollector,
  hangupTwiml,
  parseTwilioMessage,
  streamTwiml,
  TwilioAudioBridge,
  validTwilioSignature
} from "./twilio-stream";

/**
 * Phone calls through Twilio. A call reaches the assistant exactly as a web
 * session does: the media stream is adapted to the relay's own `/agent`
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

export type TelephonySettings = {
  authToken: string;
  /** Needed to transfer or place calls (the REST API), not to answer them. */
  accountSid?: string;
  /** The Twilio number outbound calls come from. */
  phoneNumber?: string;
  /** The relay's public origin, as Twilio reaches it. Derived from the request when absent. */
  publicUrl?: string;
  /** Where the assistant may transfer a call: name → E.164 number or sip: URI. */
  transferTargets: Map<string, string>;
  maxCalls: number;
};

const E164 = /^\+[1-9]\d{6,14}$/;
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
const MAX_CONTEXT_CHARS = 2_000;
const MAX_VOICEMAIL_CHARS = 500;
const REST_TIMEOUT_MS = 10_000;

/** Reads the TWILIO_* and TELEPHONY_* variables. No settings when telephony is off. */
export function telephonySettingsFromEnv(env: NodeJS.ProcessEnv = process.env): {
  settings?: TelephonySettings;
  problems: string[];
} {
  const authToken = env.TWILIO_AUTH_TOKEN?.trim();
  if (!authToken) return { problems: [] };
  const problems: string[] = [];
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim();
  if (accountSid && !SID.test(accountSid)) problems.push("TWILIO_ACCOUNT_SID is not an account SID");
  const phoneNumber = env.TWILIO_PHONE_NUMBER?.trim();
  if (phoneNumber && !E164.test(phoneNumber)) {
    problems.push("TWILIO_PHONE_NUMBER must be in E.164 form, like +14155550100");
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
  if (transferTargets.size > 0 && !accountSid) {
    problems.push("TELEPHONY_TRANSFER_NUMBERS needs TWILIO_ACCOUNT_SID: a transfer goes through Twilio's REST API");
  }
  const maxCalls = Number(env.TELEPHONY_MAX_CALLS);
  return {
    settings: {
      authToken,
      ...(accountSid && SID.test(accountSid) ? { accountSid } : {}),
      ...(phoneNumber && E164.test(phoneNumber) ? { phoneNumber } : {}),
      ...(publicUrl ? { publicUrl } : {}),
      transferTargets,
      maxCalls: Number.isInteger(maxCalls) && maxCalls > 0 ? Math.min(maxCalls, 1_000) : 20
    },
    problems
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
  /** Language for the few lines Twilio itself speaks ("en-US"). */
  language?: string;
  request?: typeof fetch;
  now?: () => number;
};

type Ticket = { call: CallInfo; expiresAt: number };
type OutboundPlan = { context?: string; userId?: string; voicemailMessage?: string; expiresAt: number };

type PlaceCallInput = { to?: unknown; context?: unknown; userId?: unknown; voicemailMessage?: unknown };

export type Telephony = {
  /** Answers Twilio's voice webhook with TwiML. `url` is the full URL Twilio requested. */
  voiceWebhook(input: { url: string; params: Record<string, string>; signature: string | undefined }): {
    status: number;
    body: string;
  };
  /** Takes over a media-stream socket. `onSettled` runs once, when the socket
   *  has presented its ticket or is gone: until then it is anybody's. */
  handleStream(socket: StreamSocket, onSettled?: () => void): void;
  /** Whether a call is waiting to open its media stream. No ticket, no socket. */
  expectsStream(): boolean;
  placeCall(
    input: PlaceCallInput,
    origin: string
  ): Promise<{ ok: true; callSid: string } | { ok: false; status: number; error: string }>;
  activeCalls(): number;
};

function rawToString(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return "";
}

function phoneOrUndefined(value: string | undefined): string | undefined {
  // Twilio also sends "anonymous", client: identities and SIP addresses here.
  return value && value.length <= 128 ? value : undefined;
}

/** A number as the assistant may be told it: digits only, never free text a caller chose. */
function dialable(value: string | undefined): string | undefined {
  return value && E164.test(value) ? value : undefined;
}

export function createTelephony(settings: TelephonySettings, deps: TelephonyDeps): Telephony {
  const now = deps.now ?? Date.now;
  const request = deps.request ?? fetch;
  const { log } = deps;
  const tickets = new Map<string, Ticket>();
  /** The one ticket a call may hold, by CallSid. */
  const ticketOf = new Map<string, string>();
  /** Calls whose stream has connected, and until when that is remembered. */
  const connected = new Map<string, number>();
  const outbound = new Map<string, OutboundPlan>();
  let active = 0;

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
  }

  /** One call to Twilio's REST API. Errors name a status at most: the body may quote our parameters. */
  async function rest(
    path: string,
    form: Record<string, string>
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    if (!settings.accountSid) return { ok: false, status: 0, body: undefined };
    try {
      const response = await request(`https://api.twilio.com/2010-04-01/Accounts/${settings.accountSid}/${path}`, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${settings.accountSid}:${settings.authToken}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(REST_TIMEOUT_MS),
        redirect: "error"
      });
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }
      return { ok: response.ok, status: response.status, body };
    } catch {
      return { ok: false, status: 0, body: undefined };
    }
  }

  function voiceWebhook(input: { url: string; params: Record<string, string>; signature: string | undefined }): {
    status: number;
    body: string;
  } {
    if (!validTwilioSignature(settings.authToken, input.url, input.params, input.signature)) {
      return { status: 403, body: hangupTwiml() };
    }
    const callSid = input.params.CallSid ?? "";
    if (!SID.test(callSid)) return { status: 400, body: hangupTwiml() };
    prune();
    // Twilio's signature has no timestamp, so a copied request stays valid.
    // A call connects once: its webhook is worth nothing afterwards.
    if (connected.has(callSid)) {
      log.warn("telephony webhook refused: this call has already connected", { callSid });
      return { status: 200, body: hangupTwiml() };
    }
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      return { status: 400, body: hangupTwiml() };
    }
    const planId = url.searchParams.get("plan");
    const plan = planId ? outbound.get(planId) : undefined;
    if (planId) outbound.delete(planId);
    // A plan id that is unknown or expired is not an inbound call in disguise.
    if (planId && !plan) return { status: 200, body: hangupTwiml() };
    if (plan) {
      const answeredBy = input.params.AnsweredBy ?? "";
      if (answeredBy.startsWith("machine") || answeredBy === "fax") {
        log.info("outbound call reached a machine", { callSid, answeredBy });
        return {
          status: 200,
          body: hangupTwiml(answeredBy === "fax" ? undefined : plan.voicemailMessage, deps.language)
        };
      }
    }
    if (active >= settings.maxCalls) {
      log.warn("call refused: every line is busy", { callSid, active });
      return {
        status: 200,
        body: `<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="busy"/></Response>`
      };
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
    // Twilio asking again for the same call (a retry) gets the ticket the call
    // already holds, for what is left of its life. A new one would cancel the
    // first, and a stream that is already on its way with it would be refused.
    const earlier = ticketOf.get(callSid);
    const held = earlier ? tickets.get(earlier) : undefined;
    const ticket = earlier && held && held.expiresAt > now() ? earlier : randomBytes(24).toString("base64url");
    if (ticket !== earlier) {
      if (earlier) tickets.delete(earlier);
      tickets.set(ticket, { call, expiresAt: now() + TICKET_TTL_MS });
      ticketOf.set(callSid, ticket);
    }
    const origin = settings.publicUrl ?? url.origin;
    const streamUrl = `${origin.replace(/^http/, "ws")}/telephony/twilio/stream`;
    return { status: 200, body: streamTwiml(streamUrl, { ticket }) };
  }

  function handleStream(socket: StreamSocket, onSettled?: () => void): void {
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      onSettled?.();
    };
    /** The session has ended on its own account (it hung up, or hit its limit). */
    let sessionDone: string | undefined;
    let session: CallSession | undefined;
    let bridge: TwilioAudioBridge | undefined;
    let call: CallInfo | undefined;
    let closed = false;
    let counted = false;
    /** The session asked to hang up: the socket closes once Twilio has played what it holds. */
    let hangingUp = false;
    let endReason: string | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    /** Where the call goes once the assistant has announced the transfer. */
    let transferTo: { name: string; destination: string } | undefined;
    let transferTimer: NodeJS.Timeout | undefined;
    let transferSpoken = false;
    let transferring = false;
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
      try {
        socket.close(1000);
      } catch {
        /* already gone */
      }
      session?.close(endReason ?? reason);
      if (call) log.info("call ended", { callSid: call.callSid, reason: endReason ?? reason ?? "caller" });
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
      const callSid = call.callSid;
      afterPlayback("transfer", () => {
        void rest(`Calls/${callSid}.json`, {
          Twiml: dialTwiml(target.destination, settings.phoneNumber ? { callerId: settings.phoneNumber } : {})
        }).then((result) => {
          if (result.ok) {
            log.info("call transferred", { callSid, to: target.name });
            endReason = "transfer";
            // Twilio now stops the stream itself; do not wait for it forever.
            setTimeout(() => finish("transfer"), 3_000).unref?.();
            return;
          }
          log.warn("call transfer failed", { callSid, to: target.name, status: result.status });
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
      if (settings.transferTargets.size === 0 || !settings.accountSid) return [];
      const names = [...settings.transferTargets.keys()];
      return [
        {
          name: "transfer_call",
          description:
            "Transfer the phone call to a person or department. Use it when the caller asks for a human, or needs something only that destination can do.",
          parameters: {
            type: "object",
            properties: { destination: { type: "string", enum: names, description: "Where to transfer the call." } },
            required: ["destination"]
          },
          handler: (args) => {
            const name = typeof args.destination === "string" ? args.destination.trim() : "";
            // Only the owner's list: the model never supplies a number.
            const destination = settings.transferTargets.get(name);
            if (!destination) throw new Error(`there is no transfer destination called ${name || "that"}`);
            if (transferTo) return { ok: true, note: "The transfer is already under way. Say nothing more." };
            transferTo = { name, destination };
            transferSpoken = false;
            // The assistant announces it first; if it never does, transfer anyway.
            transferTimer = setTimeout(completeTransfer, TRANSFER_ANNOUNCE_MS);
            return {
              ok: true,
              note: `The call will be transferred to ${name} as soon as you stop speaking. Tell the caller in one short sentence that you are transferring them now, then say nothing more.`
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
        let event: { type?: unknown; state?: unknown; reason?: unknown; message?: unknown };
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
      const message = parseTwilioMessage(rawToString(data));
      if (!message) return;
      if (message.event === "start") {
        if (session) return;
        prune();
        const presented = message.customParameters.ticket ?? "";
        const ticket = tickets.get(presented);
        tickets.delete(presented);
        if (ticket && ticketOf.get(ticket.call.callSid) === presented) ticketOf.delete(ticket.call.callSid);
        // The ticket must be fresh and for this very call.
        if (!ticket || ticket.expiresAt <= now() || ticket.call.callSid !== message.callSid) {
          log.warn("media stream refused: unknown or expired ticket");
          finish("unauthorised");
          return;
        }
        if (active >= settings.maxCalls) {
          finish("busy");
          return;
        }
        call = ticket.call;
        active += 1;
        counted = true;
        connected.set(call.callSid, now() + CALL_MEMORY_MS);
        settle();
        bridge = new TwilioAudioBridge(message.streamSid);
        const callerId = dialable(call.from);
        const facts = [
          call.direction === "inbound"
            ? `This is an incoming phone call${dialable(call.to) ? ` to ${dialable(call.to)}` : ""}.${
                callerId
                  ? ` The caller ID shows ${callerId}. Caller ID can be faked: it is never proof of who is calling, so confirm identity another way before acting on an account.`
                  : ""
              }`
            : `You placed this phone call${dialable(call.to) ? ` to ${dialable(call.to)}` : ""}. The person who answered did not expect it: say who you are and why you are calling.`,
          ...(call.context ? [call.context] : [])
        ].join("\n");
        const opened = deps.openSession(client, call, { sessionTools: transferTool(), trustedContext: facts });
        if ("refused" in opened) {
          log.warn("call refused", { callSid: call.callSid, reason: opened.refused });
          finish(opened.refused);
          return;
        }
        session = opened;
        clearTimeout(startTimer);
        log.info("call connected", { callSid: call.callSid, direction: call.direction });
        sendEvent({ type: "session.start", sampleRate: 16000, channels: 1 });
        sendEvent({ type: "audio.start" });
        return;
      }
      if (!session || !bridge) return;
      if (message.event === "media") {
        for (const frame of bridge.inbound(message.payload, message.track)) toSession(frame, true);
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

  async function placeCall(
    input: PlaceCallInput,
    origin: string
  ): Promise<{ ok: true; callSid: string } | { ok: false; status: number; error: string }> {
    if (!settings.accountSid || !settings.phoneNumber) {
      return { ok: false, status: 503, error: "Set TWILIO_ACCOUNT_SID and TWILIO_PHONE_NUMBER to place calls." };
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
    if (active >= settings.maxCalls) return { ok: false, status: 429, error: "Every line is busy." };
    prune();
    const plan = randomBytes(24).toString("base64url");
    outbound.set(plan, {
      ...(typeof context === "string" ? { context } : {}),
      ...(typeof userId === "string" ? { userId } : {}),
      ...(typeof voicemailMessage === "string" ? { voicemailMessage } : {}),
      expiresAt: now() + OUTBOUND_TTL_MS
    });
    const base = settings.publicUrl ?? origin;
    const result = await rest("Calls.json", {
      To: to,
      From: settings.phoneNumber,
      Url: `${base}/telephony/twilio/voice?plan=${plan}`,
      Method: "POST",
      // Tells the voice webhook whether a person or a machine picked up.
      MachineDetection: "Enable"
    });
    const sid = result.body && typeof result.body === "object" ? (result.body as { sid?: unknown }).sid : undefined;
    if (!result.ok || typeof sid !== "string") {
      outbound.delete(plan);
      log.warn("outbound call could not be placed", { status: result.status });
      return {
        ok: false,
        status: 502,
        error: result.status ? `Twilio refused the call (HTTP ${result.status}).` : "Twilio could not be reached."
      };
    }
    log.info("outbound call placed", { callSid: sid });
    return { ok: true, callSid: sid };
  }

  const expectsStream = (): boolean => {
    const at = now();
    for (const ticket of tickets.values()) if (ticket.expiresAt > at) return true;
    return false;
  };

  return { voiceWebhook, handleStream, expectsStream, placeCall, activeCalls: () => active };
}
