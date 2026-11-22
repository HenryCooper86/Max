import { createPublicKey, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import type { Carrier, CarrierMessage } from "./carrier";
import { callSettingsFromEnv, carrierPost, type CallSettings } from "./twilio-calls";
import { dialTwiml, hangupTwiml, TwilioAudioBridge, xml } from "./twilio-stream";

/**
 * Telnyx as a phone carrier: TeXML (Telnyx's dialect of TwiML) for the call's
 * instructions and Telnyx media streaming for its audio.
 *
 *   caller ── PSTN ── Telnyx ──GET or POST /telephony/telnyx/voice?key=…──▶ relay (TeXML: connect a stream)
 *                        └─────WS  /telephony/telnyx/stream?ticket=…─────▶ relay (μ-law 8 kHz both ways)
 *
 * How the relay knows it is Telnyx. Telnyx's documentation does not say how
 * (or whether) the request for a call's instructions is signed, so the relay
 * does not lean on a signature there: the webhook URL you give Telnyx carries
 * a secret of your own (`?key=`), and a request without it is refused. The
 * media stream is documented as signed (Ed25519 over `<timestamp>|<stream
 * URL>`), and the relay checks that with `TELNYX_PUBLIC_KEY`. The key is
 * required: the secret alone gets someone a ticket, and only Telnyx's
 * signature turns a ticket into a session. As
 * on every carrier, a stream must also present the single-use ticket that the
 * voice webhook issued for its call. Telnyx does not document how a stream's
 * custom parameters arrive, so the ticket travels in the stream's URL, which
 * is also what the signature covers.
 *
 * Written to Telnyx's documentation. It has not been run on a real Telnyx
 * call: see docs/telephony.md.
 */

export type TelnyxSettings = CallSettings & {
  /** The secret in the webhook URL. Setting it is what turns Telnyx on. */
  webhookSecret: string;
  /** The account's public key, to check the media stream's signature. Absent only when the owner chose to go without. */
  publicKey?: KeyObject;
  /** For the REST API: transfers and outbound calls. */
  apiKey?: string;
  /** The account id in REST paths. */
  accountSid?: string;
  /** The TeXML application outbound calls are placed through. */
  applicationSid?: string;
};

/** Telnyx call ids look like `v3:MdI91X4lWFEs7IgbBEOT9M4AigoY08M0WWZFISt1Yw2axZ_IiE4pqg`. */
const CALL_ID = /^[A-Za-z0-9:_.-]{1,160}$/;
const ACCOUNT_ID = /^[A-Za-z0-9-]{1,64}$/;
const MIN_SECRET_CHARS = 16;
/** How old a signed stream request may be. */
const SIGNATURE_TOLERANCE_SECONDS = 300;
const MAX_PAYLOAD_CHARS = 64 * 1024;
const MAX_ID = 256;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const DTMF_DIGIT = /^[0-9*#A-D]$/;
/** The fixed start of a DER-encoded Ed25519 public key; the 32 key bytes follow. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * The points of small order on the Ed25519 curve, without their sign bit. As a
 * public key each of them accepts a signature anyone can write, so a key that
 * is one of them (all zeros, say, left as a placeholder) checks nothing.
 */
const WEAK_KEYS = new Set([
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0100000000000000000000000000000000000000000000000000000000000000",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"
]);

/** Reads an Ed25519 public key given as PEM, or as its 32 bytes in base64 or hex. */
export function telnyxPublicKey(text: string): KeyObject | undefined {
  const value = text.trim();
  try {
    let key: KeyObject;
    if (value.includes("BEGIN")) {
      key = createPublicKey(value);
    } else {
      let raw: Buffer;
      if (/^[0-9a-fA-F]{64}$/.test(value)) raw = Buffer.from(value, "hex");
      else if (/^[A-Za-z0-9+/_-]{43}=?$/.test(value)) raw = Buffer.from(value, "base64");
      else return undefined;
      if (raw.length !== 32) return undefined;
      key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
    }
    if (key.asymmetricKeyType !== "ed25519") return undefined;
    const point = Buffer.from(key.export({ format: "der", type: "spki" }).subarray(ED25519_SPKI_PREFIX.length));
    point[31] = point[31]! & 0x7f;
    return WEAK_KEYS.has(point.toString("hex")) ? undefined : key;
  } catch {
    return undefined;
  }
}

/** Reads the TELNYX_* and TELEPHONY_* variables. No settings when Telnyx is not set up. */
export function telnyxSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): {
  settings?: TelnyxSettings;
  problems: string[];
} {
  const webhookSecret = env.TELNYX_WEBHOOK_SECRET?.trim();
  if (!webhookSecret) return { problems: [] };
  if (webhookSecret.length < MIN_SECRET_CHARS || !/^[A-Za-z0-9_-]+$/.test(webhookSecret)) {
    return {
      problems: [
        `TELNYX_WEBHOOK_SECRET must be at least ${MIN_SECRET_CHARS} letters, digits, - or _. Telnyx calls are off.`
      ]
    };
  }
  const problems: string[] = [];
  let publicKey: KeyObject | undefined;
  const rawKey = env.TELNYX_PUBLIC_KEY?.trim();
  if (rawKey) {
    publicKey = telnyxPublicKey(rawKey);
    if (!publicKey) {
      // Refusing every stream would be the safe reading of a key that cannot be used.
      return {
        problems: ["TELNYX_PUBLIC_KEY is not a usable Ed25519 public key (base64, hex or PEM). Telnyx calls are off."]
      };
    }
  } else if (env.TELNYX_UNSIGNED_STREAMS?.trim().toLowerCase() === "allow") {
    problems.push(
      "TELNYX_UNSIGNED_STREAMS=allow: media streams are accepted without Telnyx's signature. Anyone who learns the webhook secret can then talk to the assistant without placing a call."
    );
  } else {
    return {
      problems: [
        "TELNYX_WEBHOOK_SECRET is set without TELNYX_PUBLIC_KEY, which checks that a media stream comes from Telnyx. Telnyx calls are off."
      ]
    };
  }
  const apiKey = env.TELNYX_API_KEY?.trim() || undefined;
  const accountSid = env.TELNYX_ACCOUNT_SID?.trim() || undefined;
  const applicationSid = env.TELNYX_APPLICATION_SID?.trim() || undefined;
  if (accountSid && !ACCOUNT_ID.test(accountSid)) problems.push("TELNYX_ACCOUNT_SID is not an account id");
  if (applicationSid && !ACCOUNT_ID.test(applicationSid)) {
    problems.push("TELNYX_APPLICATION_SID is not a TeXML application id");
  }
  const rest = Boolean(apiKey && accountSid && ACCOUNT_ID.test(accountSid));
  const shared = callSettingsFromEnv(env, {
    numberVariable: "TELNYX_PHONE_NUMBER",
    canTransfer: rest,
    needs: "TELNYX_API_KEY and TELNYX_ACCOUNT_SID: a transfer goes through Telnyx's REST API"
  });
  return {
    settings: {
      ...shared.settings,
      webhookSecret,
      ...(publicKey ? { publicKey } : {}),
      ...(rest ? { apiKey, accountSid } : {}),
      ...(rest && applicationSid && ACCOUNT_ID.test(applicationSid) ? { applicationSid } : {})
    },
    problems: [...problems, ...shared.problems]
  };
}

/**
 * Whether a media-stream request carries Telnyx's signature for exactly this
 * stream URL: Ed25519 over `<telnyx-timestamp>|<stream URL>`, base64 in
 * `telnyx-signature-ed25519`. False for a timestamp more than five minutes off.
 */
export function validTelnyxStreamSignature(input: {
  publicKey: KeyObject;
  streamUrl: string;
  timestamp: string | undefined;
  signature: string | undefined;
  now?: number;
}): boolean {
  const { timestamp, signature } = input;
  if (!timestamp || !signature || !/^\d{1,12}$/.test(timestamp) || signature.length > 256) return false;
  const age = Math.abs((input.now ?? Date.now()) / 1000 - Number(timestamp));
  if (age > SIGNATURE_TOLERANCE_SECONDS) return false;
  try {
    const given = Buffer.from(signature, "base64");
    if (given.length !== 64) return false;
    return verify(null, Buffer.from(`${timestamp}|${input.streamUrl}`, "utf8"), input.publicKey, given);
  } catch {
    return false;
  }
}

/**
 * Parses one text message from Telnyx's media stream. Returns undefined for
 * anything malformed, oversized or unknown, and never throws.
 */
export function parseTelnyxMessage(raw: string): CarrierMessage | undefined {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(message)) return undefined;
  switch (message.event) {
    case "stop":
      return { event: "stop" };
    case "start": {
      const streamId = message.stream_id;
      if (typeof streamId !== "string" || !streamId || streamId.length > MAX_ID) return undefined;
      // The relay asked for μ-law at 8 kHz. Anything else would be decoded into noise.
      const format = isRecord(message.start) ? message.start.media_format : undefined;
      let unusable: string | undefined;
      if (isRecord(format)) {
        const { encoding, sample_rate: rate, channels } = format;
        if (
          (encoding !== undefined && encoding !== "PCMU") ||
          (rate !== undefined && Number(rate) !== 8000) ||
          (channels !== undefined && Number(channels) !== 1)
        ) {
          unusable = `the audio is ${String(encoding).slice(0, 16)} at ${String(rate).slice(0, 8)} Hz, not PCMU at 8000 Hz`;
        }
      }
      // The call is not named here in the voice webhook's terms, so the ticket alone ties the two.
      return { event: "start", streamId, ...(unusable ? { unusable } : {}) };
    }
    case "error": {
      const payload = isRecord(message.payload) ? message.payload : {};
      const detail = [payload.code, payload.title, payload.detail]
        .filter((part) => typeof part === "string" || typeof part === "number")
        .join(" ")
        .slice(0, 200);
      return { event: "problem", detail: detail || "unknown" };
    }
    case "media": {
      const media = message.media;
      if (!isRecord(media) || typeof media.payload !== "string") return undefined;
      if (media.payload.length > MAX_PAYLOAD_CHARS || !BASE64.test(media.payload)) return undefined;
      const track = media.track === "inbound" || media.track === "outbound" ? media.track : undefined;
      // Telnyx: "The order of events is not guaranteed. Use sequence_number or chunk to reorder them."
      const chunk =
        typeof media.chunk === "string" && /^\d{1,12}$/.test(media.chunk) ? Number(media.chunk) : media.chunk;
      const sequence = typeof chunk === "number" && Number.isInteger(chunk) && chunk >= 0 ? chunk : undefined;
      return {
        event: "media",
        payload: media.payload,
        ...(track ? { track } : {}),
        ...(sequence !== undefined ? { sequence } : {})
      };
    }
    case "dtmf": {
      const dtmf = message.dtmf;
      if (!isRecord(dtmf) || typeof dtmf.digit !== "string" || !DTMF_DIGIT.test(dtmf.digit)) return undefined;
      return { event: "dtmf", digit: dtmf.digit };
    }
    case "mark": {
      const mark = message.mark;
      const name = isRecord(mark) && typeof mark.name === "string" ? mark.name : "";
      return name && name.length <= MAX_ID ? { event: "mark", name } : undefined;
    }
    default:
      return undefined;
  }
}

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>';

/**
 * TeXML that connects the call to a two-way stream of raw μ-law audio. The
 * caller's track only: the relay has no use for an echo of its own voice.
 * Telnyx would reconnect a dropped stream to the same URL, whose ticket has
 * been used by then, so reconnecting is turned off.
 */
export function streamTexml(streamUrl: string): string {
  return (
    `${XML_HEADER}<Response><Connect><Stream url="${xml(streamUrl)}" track="inbound_track" codec="PCMU"` +
    ` bidirectionalMode="rtp" bidirectionalCodec="PCMU" bidirectionalSamplingRate="8000"` +
    ` enableReconnect="false"/></Connect></Response>`
  );
}

/**
 * The stream URL as Telnyx was given it, and so as Telnyx signed it: the
 * relay's public origin, and the path and query of the request. Without a
 * configured public address the origin is the one the request names.
 */
export function telnyxSignedStreamUrl(input: {
  publicUrl?: string;
  host?: string;
  forwardedProto?: string;
  encrypted: boolean;
  requestUrl: string;
}): string {
  const proto = input.forwardedProto?.split(",")[0]?.trim().toLowerCase();
  const secure = proto ? proto === "https" || proto === "wss" : input.encrypted;
  const origin = input.publicUrl?.replace(/^http/, "ws") ?? `${secure ? "wss" : "ws"}://${input.host ?? "localhost"}`;
  return `${origin}${input.requestUrl}`;
}

function sameSecret(given: string | null, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The id Telnyx gives a call it accepted, wherever in the answer it put it. */
function callIdIn(body: unknown): string | undefined {
  const holders = isRecord(body) ? [body, ...(isRecord(body.data) ? [body.data] : [])] : [];
  for (const holder of holders) {
    for (const name of ["call_sid", "sid", "CallSid", "call_control_id"]) {
      const value = holder[name];
      if (typeof value === "string" && CALL_ID.test(value)) return value;
    }
  }
  return undefined;
}

/** Telnyx: media streaming, TeXML, and the TeXML REST API. */
export function telnyxCarrier(settings: TelnyxSettings, request: typeof fetch = fetch): Carrier {
  const { apiKey, accountSid } = settings;
  const api = apiKey && accountSid ? `https://api.telnyx.com/v2/texml/Accounts/${accountSid}/Calls` : undefined;
  return {
    id: "telnyx",
    label: "Telnyx",
    validCallId: (id) => CALL_ID.test(id),
    authentic(input) {
      try {
        return sameSecret(new URL(input.url).searchParams.get("key"), settings.webhookSecret);
      } catch {
        return false;
      }
    },
    voiceUrl: (base, plan) => `${base}/telephony/telnyx/voice?key=${settings.webhookSecret}&plan=${plan}`,
    voiceUrlIsSecret: true,
    answerXml: (streamUrl, ticket) => streamTexml(`${streamUrl}?ticket=${ticket}`),
    dialXml: (destination, options) => dialTwiml(destination, options),
    hangupXml: (say, language) => hangupTwiml(say, language),
    // TeXML has <Reject> as TwiML does.
    busyXml: () => `${XML_HEADER}<Response><Reject reason="busy"/></Response>`,
    parse: parseTelnyxMessage,
    bridge: (streamId) => new TwilioAudioBridge(streamId, "telnyx"),
    // Telnyx reports who answered to a status callback, not to the request for instructions.
    detectsMachines: false,
    placeCallHelp:
      "Set TELNYX_API_KEY, TELNYX_ACCOUNT_SID, TELNYX_APPLICATION_SID and TELNYX_PHONE_NUMBER to place calls.",
    ...(api && apiKey
      ? {
          async updateCall(callId: string, texml: string) {
            const result = await carrierPost(
              request,
              `${api}/${encodeURIComponent(callId)}`,
              { authorization: `Bearer ${apiKey}`, "content-type": "application/x-www-form-urlencoded" },
              new URLSearchParams({ Texml: texml }).toString()
            );
            return { ok: result.ok, status: result.status };
          }
        }
      : {}),
    ...(api && apiKey && settings.applicationSid
      ? {
          async placeCall(input: { to: string; from: string; url: string }) {
            const result = await carrierPost(
              request,
              api,
              { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
              JSON.stringify({
                To: input.to,
                From: input.from,
                ApplicationSid: settings.applicationSid,
                Url: input.url,
                UrlMethod: "POST"
              })
            );
            const callId = callIdIn(result.body);
            return { ok: result.ok, status: result.status, ...(callId ? { callId } : {}) };
          }
        }
      : {})
  };
}
