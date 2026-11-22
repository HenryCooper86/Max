import { createHmac, timingSafeEqual } from "node:crypto";
import { PacketOrder } from "../packet-order";
import { Downsampler24to8, mulawDecode, mulawEncode, Upsampler8to16 } from "./g711";

/**
 * Twilio Media Streams: the WebSocket protocol, the audio conversion between
 * it and the relay's PCM contract, and the HTTP-side helpers (webhook
 * signatures and TwiML). Nothing here touches a socket or a clock of its own,
 * so the server can wire it in and the tests can drive it directly.
 */

export type TwilioInbound =
  | { event: "connected" }
  | {
      event: "start";
      streamSid: string;
      callSid: string;
      accountSid?: string;
      customParameters: Record<string, string>;
    }
  | { event: "media"; payload: string; track?: string }
  | { event: "dtmf"; digit: string }
  | { event: "mark"; name: string }
  | { event: "stop" };

const MAX_PAYLOAD_CHARS = 64 * 1024;
const MAX_PARAMETERS = 32;
const MAX_PARAMETER_NAME = 64;
const MAX_PARAMETER_VALUE = 2048;
const MAX_SID = 128;
const MAX_MARK_NAME = 256;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const DTMF_DIGIT = /^[0-9*#A-D]$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function shortString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

/**
 * Parses one text message from Twilio. Returns undefined for anything malformed,
 * oversized or unknown, and never throws: the socket is an untrusted input and
 * the caller should simply ignore what it cannot use.
 */
export function parseTwilioMessage(raw: string): TwilioInbound | undefined {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(message)) return undefined;
  switch (message.event) {
    case "connected":
      return { event: "connected" };
    case "stop":
      return { event: "stop" };
    case "start": {
      const start = message.start;
      if (!isRecord(start)) return undefined;
      const streamSid = shortString(start.streamSid ?? message.streamSid, MAX_SID);
      const callSid = shortString(start.callSid, MAX_SID);
      if (!streamSid || !callSid) return undefined;
      const customParameters: Record<string, string> = {};
      if (start.customParameters !== undefined) {
        if (!isRecord(start.customParameters)) return undefined;
        const entries = Object.entries(start.customParameters);
        if (entries.length > MAX_PARAMETERS) return undefined;
        for (const [name, value] of entries) {
          if (name.length > MAX_PARAMETER_NAME || typeof value !== "string" || value.length > MAX_PARAMETER_VALUE)
            return undefined;
          customParameters[name] = value;
        }
      }
      const accountSid = shortString(start.accountSid, MAX_SID);
      return { event: "start", streamSid, callSid, ...(accountSid ? { accountSid } : {}), customParameters };
    }
    case "media": {
      const media = message.media;
      if (!isRecord(media) || typeof media.payload !== "string") return undefined;
      if (media.payload.length > MAX_PAYLOAD_CHARS || !BASE64.test(media.payload)) return undefined;
      const track = typeof media.track === "string" && media.track.length <= 32 ? media.track : undefined;
      return { event: "media", payload: media.payload, ...(track ? { track } : {}) };
    }
    case "dtmf": {
      const dtmf = message.dtmf;
      if (!isRecord(dtmf) || typeof dtmf.digit !== "string" || !DTMF_DIGIT.test(dtmf.digit)) return undefined;
      return { event: "dtmf", digit: dtmf.digit };
    }
    case "mark": {
      const mark = message.mark;
      const name = isRecord(mark) ? shortString(mark.name, MAX_MARK_NAME) : undefined;
      return name ? { event: "mark", name } : undefined;
    }
    default:
      return undefined;
  }
}

/** 20 ms of PCM16 mono at 16 kHz. */
const INBOUND_FRAME_BYTES = 640;
/** 20 ms of μ-law at 8 kHz. */
const OUTBOUND_FRAME_BYTES = 160;
const MULAW_SILENCE = 0xff;

/**
 * Audio conversion for one call, both directions. Twilio chunk boundaries have
 * nothing to do with the 20 ms framing the relay expects, so each direction
 * keeps a small carry and the resamplers keep their filter state.
 */
export class TwilioAudioBridge {
  private readonly up = new Upsampler8to16();
  private readonly down = new Downsampler24to8();
  private readonly order = new PacketOrder();
  private inboundCarry: Buffer = Buffer.alloc(0);
  private outboundCarry: Buffer = Buffer.alloc(0);

  /**
   * `wire` is whose message format to write. Telnyx's media stream is Twilio's
   * with two differences: its messages do not name the stream, and it does not
   * promise to deliver audio frames in order.
   */
  constructor(
    private readonly streamSid: string,
    private readonly wire: "twilio" | "telnyx" = "twilio"
  ) {}

  /**
   * Caller audio: one media payload → whole 640-byte PCM16 16 kHz frames. Only
   * the caller's own track counts. With a `sequence`, frames that arrive out
   * of order are put back in order first.
   */
  inbound(payloadBase64: string, track?: string, sequence?: number): Buffer[] {
    if (track !== undefined && track !== "inbound") return [];
    const mulaw = Buffer.from(payloadBase64, "base64");
    if (sequence === undefined) return this.frames(mulaw);
    return this.order.push(sequence & 0xffff, mulaw).flatMap((ready) => this.frames(ready));
  }

  private frames(mulaw: Buffer): Buffer[] {
    const pcm = this.up.process(mulawDecode(mulaw));
    let pending = this.inboundCarry.length ? Buffer.concat([this.inboundCarry, pcm]) : pcm;
    const frames: Buffer[] = [];
    while (pending.length >= INBOUND_FRAME_BYTES) {
      frames.push(Buffer.from(pending.subarray(0, INBOUND_FRAME_BYTES)));
      pending = pending.subarray(INBOUND_FRAME_BYTES);
    }
    this.inboundCarry = Buffer.from(pending);
    return frames;
  }

  /** Assistant audio: PCM16 24 kHz of any length → `media` messages of exactly 160 μ-law bytes each. */
  outbound(pcm24k: Buffer): string[] {
    const mulaw = mulawEncode(this.down.process(pcm24k));
    let pending = this.outboundCarry.length ? Buffer.concat([this.outboundCarry, mulaw]) : mulaw;
    const messages: string[] = [];
    while (pending.length >= OUTBOUND_FRAME_BYTES) {
      messages.push(this.mediaMessage(pending.subarray(0, OUTBOUND_FRAME_BYTES)));
      pending = pending.subarray(OUTBOUND_FRAME_BYTES);
    }
    this.outboundCarry = Buffer.from(pending);
    return messages;
  }

  /** Pads what is left to a whole frame with μ-law silence so the last syllable is not lost. */
  flush(): string[] {
    if (this.outboundCarry.length === 0) return [];
    const frame = Buffer.alloc(OUTBOUND_FRAME_BYTES, MULAW_SILENCE);
    this.outboundCarry.copy(frame);
    this.outboundCarry = Buffer.alloc(0);
    return [this.mediaMessage(frame)];
  }

  /** Makes Twilio drop the audio it has buffered (barge-in) and forgets ours, so the next reply starts clean. */
  clear(): string {
    this.outboundCarry = Buffer.alloc(0);
    this.down.reset();
    return JSON.stringify(this.wire === "twilio" ? { event: "clear", streamSid: this.streamSid } : { event: "clear" });
  }

  /** Twilio echoes the name back when playback reaches this point. */
  mark(name: string): string {
    return JSON.stringify(
      this.wire === "twilio"
        ? { event: "mark", streamSid: this.streamSid, mark: { name } }
        : { event: "mark", mark: { name } }
    );
  }

  private mediaMessage(mulaw: Buffer): string {
    const media = { payload: mulaw.toString("base64") };
    return JSON.stringify(
      this.wire === "twilio" ? { event: "media", streamSid: this.streamSid, media } : { event: "media", media }
    );
  }
}

const DTMF_MAX_DIGITS = 32;

/**
 * Groups keypad presses into sequences, because a person entering an account
 * number presses digits one at a time. A sequence ends at `#`, after a pause,
 * or at 32 digits so a stuck key cannot grow it without bound.
 */
export class DtmfCollector {
  private digits = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly gapMs: number;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;

  constructor(
    private readonly onSequence: (digits: string) => void,
    options: { gapMs?: number; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout } = {}
  ) {
    this.gapMs = options.gapMs ?? 2000;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  digit(digit: string): void {
    if (digit === "#") {
      this.flush();
      return;
    }
    this.digits += digit;
    if (this.digits.length >= DTMF_MAX_DIGITS) {
      this.flush();
      return;
    }
    this.stopTimer();
    this.timer = this.setTimer(() => this.flush(), this.gapMs);
    this.timer?.unref?.();
  }

  /** Emits what has been collected, if anything. */
  flush(): void {
    this.stopTimer();
    const digits = this.digits;
    this.digits = "";
    if (digits) this.onSequence(digits);
  }

  /** Drops what has been collected and stops the timer. */
  close(): void {
    this.stopTimer();
    this.digits = "";
  }

  private stopTimer(): void {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
  }
}

/**
 * The X-Twilio-Signature value for an HTTP webhook: base64 HMAC-SHA1, keyed with
 * the auth token, of the full URL followed by each POST parameter's name and
 * value in name order.
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .reduce((text, name) => text + name + params[name], url);
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

/** Constant-time check of a request's signature header. False when the header or token is missing. */
export function validTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  header: string | undefined
): boolean {
  if (!authToken || !header) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function xml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&apos;";
    }
  });
}

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>';

function say(text: string | undefined, language: string | undefined): string {
  if (!text) return "";
  const attribute = language ? ` language="${xml(language)}"` : "";
  return `<Say${attribute}>${xml(text)}</Say>`;
}

/** TwiML that connects the call to a bidirectional media stream, with custom parameters. */
export function streamTwiml(streamUrl: string, parameters: Record<string, string> = {}): string {
  const inner = Object.entries(parameters)
    .map(([name, value]) => `<Parameter name="${xml(name)}" value="${xml(value)}"/>`)
    .join("");
  return `${XML_HEADER}<Response><Connect><Stream url="${xml(streamUrl)}">${inner}</Stream></Connect></Response>`;
}

const E164 = /^\+[1-9]\d{6,14}$/;
const SIP_URI = /^sip:[^\s<>]+$/;

/** TwiML that transfers the call to a phone number or SIP URI, optionally saying a line first. Throws on any other destination. */
export function dialTwiml(
  destination: string,
  options: { callerId?: string; say?: string; language?: string } = {}
): string {
  const isSip = SIP_URI.test(destination);
  if (!isSip && !E164.test(destination)) throw new Error("Dial destination must be an E.164 number or a sip: URI");
  const callerId = options.callerId ? ` callerId="${xml(options.callerId)}"` : "";
  const target = isSip ? `<Sip>${xml(destination)}</Sip>` : `<Number>${xml(destination)}</Number>`;
  return `${XML_HEADER}<Response>${say(options.say, options.language)}<Dial${callerId}>${target}</Dial></Response>`;
}

/**
 * TwiML for a transfer that can come back. Whoever answers hears the TwiML at
 * `whisperUrl` before the two are connected, and when the dial is over Twilio
 * asks `actionUrl` what to do with the caller. Throws on a destination that
 * is neither an E.164 number nor a sip: URI.
 */
export function warmDialTwiml(
  destination: string,
  options: { callerId?: string; whisperUrl: string; actionUrl: string; timeoutSeconds: number }
): string {
  const isSip = SIP_URI.test(destination);
  if (!isSip && !E164.test(destination)) throw new Error("Dial destination must be an E.164 number or a sip: URI");
  const callerId = options.callerId ? ` callerId="${xml(options.callerId)}"` : "";
  const whisper = ` url="${xml(options.whisperUrl)}" method="POST"`;
  const target = isSip ? `<Sip${whisper}>${xml(destination)}</Sip>` : `<Number${whisper}>${xml(destination)}</Number>`;
  const timeout = Math.min(Math.max(Math.round(options.timeoutSeconds), 5), 120);
  return `${XML_HEADER}<Response><Dial${callerId} timeout="${timeout}" action="${xml(options.actionUrl)}" method="POST">${target}</Dial></Response>`;
}

/**
 * TwiML for the person who picks up a transferred call: what the call is
 * about, in the carrier's voice. With `confirm` they must press a key to take
 * the call, and it is hung up on their side when they do not: an answering
 * machine cannot take a call.
 */
export function whisperTwiml(
  text: string | undefined,
  language: string | undefined,
  confirm?: { prompt: string; actionUrl: string }
): string {
  if (!confirm) return `${XML_HEADER}<Response>${say(text, language)}</Response>`;
  return `${XML_HEADER}<Response><Gather numDigits="1" timeout="8" action="${xml(confirm.actionUrl)}" method="POST">${say(text, language)}${say(confirm.prompt, language)}</Gather><Hangup/></Response>`;
}

/** TwiML with nothing in it: whatever was to happen next happens. */
export const EMPTY_TWIML = `${XML_HEADER}<Response/>`;

/** TwiML that says an optional line and hangs up. */
export function hangupTwiml(sayText?: string, language?: string): string {
  return `${XML_HEADER}<Response>${say(sayText, language)}<Hangup/></Response>`;
}
