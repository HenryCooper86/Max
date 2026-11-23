import { createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../server/logger";
import type { ToolDefinition } from "../server/tools";
import {
  parseTelnyxMessage,
  streamTexml,
  telnyxCarrier,
  telnyxPublicKey,
  telnyxSettingsFromEnv,
  telnyxSignedStreamUrl,
  validTelnyxStreamSignature,
  type TelnyxSettings
} from "../server/telephony/telnyx";
import { createTelephony, type CallClient, type CallInfo, type StreamSocket } from "../server/telephony/twilio-calls";
import { mulawEncode } from "../server/telephony/g711";

// Telnyx as a carrier. A fake Telnyx stands on the other side: the message
// shapes are the ones in Telnyx's documentation, not ones seen on a real call.

const SECRET = "telnyx-hook-secret-0123456789";
const VOICE_URL = `https://relay.example.com/telephony/telnyx/voice?key=${SECRET}`;
const CALL_SID = "v3:MdI91X4lWFEs7IgbBEOT9M4AigoY08M0WWZFISt1Yw2axZ_IiE4pqg";
const STREAM_ID = "32de0dea-53cb-4b21-89a4-9e1819c043bc";
const ACCOUNT = "61bf923e-5e4d-4595-a110-56190ea18a1b";
const PUBLIC = "https://voice.example.com";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

type Msg = Record<string, unknown>;
type Listener = (...args: unknown[]) => void;

class FakeSocket implements StreamSocket {
  readyState = 1;
  sent: string[] = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  private listeners = new Map<string, Listener[]>();
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
  }
  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  /** Delivers a JSON message from Telnyx. */
  telnyx(message: Msg): void {
    for (const listener of this.listeners.get("message") ?? []) listener(Buffer.from(JSON.stringify(message)), false);
  }
  get messages(): Msg[] {
    return this.sent.map((text) => JSON.parse(text) as Msg);
  }
  ofType(event: string): Msg[] {
    return this.messages.filter((message) => message.event === event);
  }
}

type Opened = {
  client: CallClient;
  call: CallInfo;
  extras: { sessionTools: ToolDefinition[]; trustedContext: string };
  session: { handleMessage: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
};

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) as unknown as Logger;
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function settingsWith(overrides: Partial<TelnyxSettings> = {}): TelnyxSettings {
  return { webhookSecret: SECRET, transferTargets: new Map(), maxCalls: 20, ...overrides };
}

function setup(overrides: Partial<TelnyxSettings> = {}, respond?: typeof fetch) {
  const opened: Opened[] = [];
  const request = vi.fn(respond ?? (async () => jsonResponse({ from: "+1", to: "+1", status: "queued" })));
  const settings = settingsWith(overrides);
  const telephony = createTelephony(
    settings,
    {
      log: logger(),
      openSession(client, call, extras) {
        const session = { handleMessage: vi.fn(async () => {}), close: vi.fn() };
        opened.push({ client, call, extras, session });
        return session;
      }
    },
    telnyxCarrier(settings, request as unknown as typeof fetch)
  );
  return { telephony, opened, request };
}

type Harness = ReturnType<typeof setup>;

function webhook(telephony: Harness["telephony"], params: Record<string, string> = {}, url = VOICE_URL) {
  return telephony.voiceWebhook({
    url,
    params: { CallSid: CALL_SID, From: "+14155550111", To: "+14155550100", ...params },
    signature: undefined
  });
}

/** The ticket in the stream URL of a TeXML answer. */
function ticketOf(body: string): string {
  const match = /telephony\/telnyx\/stream\?ticket=([A-Za-z0-9_-]+)"/.exec(body);
  if (!match) throw new Error(`no ticket in ${body}`);
  return match[1]!;
}

const startMessage = () => ({
  event: "start",
  sequence_number: "1",
  start: {
    user_id: "3e6f995f-85f7-4705-9741-53b116d28237",
    call_control_id: "v2:T02llQxIyaRkhfRKxgAP8nY511EhFLizdvdUKJiSw8d6A9BborherQ",
    call_session_id: "ff55a038-6f7d-11ef-9692-02420aeffb1f",
    from: "+14155550111",
    to: "+14155550100",
    media_format: { encoding: "PCMU", sample_rate: 8000, channels: 1 }
  },
  stream_id: STREAM_ID
});

async function connect(harness: Harness, params: Record<string, string> = {}) {
  const response = webhook(harness.telephony, params);
  expect(response.status).toBe(200);
  const socket = new FakeSocket();
  harness.telephony.handleStream(socket, undefined, ticketOf(response.body));
  socket.telnyx({ event: "connected", version: "1.0.0" });
  socket.telnyx(startMessage());
  await vi.advanceTimersByTimeAsync(0);
  const opened = harness.opened.at(-1)!;
  return { socket, opened, client: opened.client, session: opened.session };
}

const eventsTo = (session: Opened["session"]): Msg[] =>
  session.handleMessage.mock.calls
    .filter(([, isBinary]) => isBinary === false)
    .map(([data]) => JSON.parse((data as Buffer).toString("utf8")) as Msg);
const audioTo = (session: Opened["session"]): Buffer[] =>
  session.handleMessage.mock.calls.filter(([, isBinary]) => isBinary === true).map(([data]) => data as Buffer);

/** 20 ms of μ-law holding one constant level, so frames can be told apart after decoding. */
const frame = (level: number) => mulawEncode(Buffer.from(new Int16Array(160).fill(level).buffer)).toString("base64");
const media = (chunk: number, level: number) => ({
  event: "media",
  sequence_number: String(chunk + 1),
  media: { track: "inbound", chunk: String(chunk), timestamp: String(chunk * 160), payload: frame(level) },
  stream_id: STREAM_ID
});

describe("telnyxSettingsFromEnv", () => {
  it("is off without a webhook secret, and refuses a weak one", () => {
    expect(telnyxSettingsFromEnv({})).toEqual({ problems: [] });
    expect(telnyxSettingsFromEnv({ TELNYX_API_KEY: "KEY123" })).toEqual({ problems: [] });
    const weak = telnyxSettingsFromEnv({ TELNYX_WEBHOOK_SECRET: "short" });
    expect(weak.settings).toBeUndefined();
    expect(weak.problems[0]).toContain("TELNYX_WEBHOOK_SECRET must be at least 16");
    expect(telnyxSettingsFromEnv({ TELNYX_WEBHOOK_SECRET: "has spaces and & signs 123" }).settings).toBeUndefined();
  });

  it("is off without the public key, unless the owner says unsigned streams are acceptable", () => {
    const bare = telnyxSettingsFromEnv({ TELNYX_WEBHOOK_SECRET: SECRET });
    expect(bare.settings).toBeUndefined();
    expect(bare.problems[0]).toContain("without TELNYX_PUBLIC_KEY");
    const allowed = telnyxSettingsFromEnv({ TELNYX_WEBHOOK_SECRET: SECRET, TELNYX_UNSIGNED_STREAMS: "allow" });
    expect(allowed.settings).toMatchObject({ webhookSecret: SECRET });
    expect(allowed.settings?.publicKey).toBeUndefined();
    expect(allowed.problems[0]).toContain("without Telnyx's signature");
    // Any other value is not consent.
    expect(
      telnyxSettingsFromEnv({ TELNYX_WEBHOOK_SECRET: SECRET, TELNYX_UNSIGNED_STREAMS: "on" }).settings
    ).toBeUndefined();
  });

  it("reads the settings it shares with every carrier and its own", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("base64");
    const { settings, problems } = telnyxSettingsFromEnv({
      TELNYX_WEBHOOK_SECRET: SECRET,
      TELNYX_PUBLIC_KEY: raw,
      TELNYX_API_KEY: "KEY0123",
      TELNYX_ACCOUNT_SID: ACCOUNT,
      TELNYX_APPLICATION_SID: "1234567890",
      TELNYX_PHONE_NUMBER: "+14155550100",
      TELEPHONY_PUBLIC_URL: "https://voice.example.com/x",
      TELEPHONY_TRANSFER_NUMBERS: "support=+14155550199",
      TELEPHONY_MAX_CALLS: "5"
    });
    expect(problems).toEqual([]);
    expect(settings).toMatchObject({
      webhookSecret: SECRET,
      apiKey: "KEY0123",
      accountSid: ACCOUNT,
      applicationSid: "1234567890",
      phoneNumber: "+14155550100",
      publicUrl: "https://voice.example.com",
      maxCalls: 5
    });
    expect(settings!.publicKey?.asymmetricKeyType).toBe("ed25519");
    expect([...settings!.transferTargets]).toEqual([["support", "+14155550199"]]);
  });

  it("turns Telnyx off for a public key it cannot use, instead of skipping the check", () => {
    const { settings, problems } = telnyxSettingsFromEnv({ TELNYX_WEBHOOK_SECRET: SECRET, TELNYX_PUBLIC_KEY: "nope" });
    expect(settings).toBeUndefined();
    expect(problems[0]).toContain("TELNYX_PUBLIC_KEY");
  });

  it("says that warm transfers are not done through Telnyx", () => {
    const { settings, problems } = telnyxSettingsFromEnv({
      TELNYX_WEBHOOK_SECRET: SECRET,
      TELNYX_PUBLIC_KEY: generateKeyPairSync("ed25519").publicKey.export({ format: "pem", type: "spki" }).toString(),
      TELEPHONY_WARM_TRANSFER: "on"
    });
    expect(problems).toEqual([
      "TELEPHONY_WARM_TRANSFER: calls through Telnyx are transferred without it. The relay does warm transfers on Twilio."
    ]);
    expect(settings).not.toHaveProperty("warmTransfer");
  });

  it("says what transfers and outbound calls need", () => {
    const { settings, problems } = telnyxSettingsFromEnv({
      TELNYX_WEBHOOK_SECRET: SECRET,
      TELNYX_PUBLIC_KEY: generateKeyPairSync("ed25519").publicKey.export({ format: "pem", type: "spki" }).toString(),
      TELNYX_API_KEY: "KEY0123",
      TELEPHONY_TRANSFER_NUMBERS: "support=+14155550199"
    });
    expect(problems).toEqual([
      "TELEPHONY_TRANSFER_NUMBERS needs TELNYX_API_KEY and TELNYX_ACCOUNT_SID: a transfer goes through Telnyx's REST API"
    ]);
    // Without the account id the key is of no use, so it is not kept.
    expect(settings?.apiKey).toBeUndefined();
  });
});

describe("the public key and the stream signature", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  const streamUrl = "wss://relay.example.com/telephony/telnyx/stream?ticket=abc";
  const NOW = 1_800_000_000_000;
  const signed = (timestamp: string, url = streamUrl) =>
    sign(null, Buffer.from(`${timestamp}|${url}`), privateKey).toString("base64");

  it("reads a key as base64, hex or PEM, and nothing else", () => {
    for (const text of [
      raw.toString("base64"),
      raw.toString("hex"),
      publicKey.export({ format: "pem", type: "spki" }).toString()
    ]) {
      expect(telnyxPublicKey(text)?.asymmetricKeyType).toBe("ed25519");
    }
    expect(telnyxPublicKey("")).toBeUndefined();
    expect(telnyxPublicKey(raw.subarray(1).toString("base64"))).toBeUndefined();
    // A key with something stuck on its end is not quietly cut to size.
    expect(telnyxPublicKey(`${raw.toString("base64")}!!`)).toBeUndefined();
    expect(telnyxPublicKey(`${raw.toString("hex")}00`)).toBeUndefined();
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey;
    expect(telnyxPublicKey(rsa.export({ format: "pem", type: "spki" }).toString())).toBeUndefined();
  });

  it("refuses the keys that would accept a signature anyone can write", () => {
    // With a point of small order as the key, R = the identity and S = 0 sign
    // any message whose hash happens to be a multiple of the point's order.
    const forged = Buffer.concat([Buffer.from([1]), Buffer.alloc(63)]);
    const spki = (hex: string) =>
      createPublicKey({
        key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(hex, "hex")]),
        format: "der",
        type: "spki"
      });
    const weak = [
      "0000000000000000000000000000000000000000000000000000000000000000",
      "0100000000000000000000000000000000000000000000000000000000000000",
      "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
      "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
      "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"
    ];
    for (const hex of weak) {
      // First that the danger is real on this runtime: some message in a few hundred is "signed".
      const key = spki(hex);
      let fooled = false;
      for (let i = 0; i < 400 && !fooled; i += 1)
        fooled = verify(null, Buffer.from(`1800000000|wss://x/${i}`), key, forged);
      expect(fooled).toBe(true);
      // Then that such a key is refused, in every form and with either sign bit.
      const flipped = Buffer.from(hex, "hex");
      flipped[31] = flipped[31]! ^ 0x80;
      for (const text of [hex, Buffer.from(hex, "hex").toString("base64"), flipped.toString("hex")]) {
        expect(telnyxPublicKey(text)).toBeUndefined();
      }
      expect(telnyxPublicKey(key.export({ format: "pem", type: "spki" }).toString())).toBeUndefined();
    }
    expect(
      telnyxSettingsFromEnv({ TELNYX_WEBHOOK_SECRET: SECRET, TELNYX_PUBLIC_KEY: "0".repeat(64) }).settings
    ).toBeUndefined();
  });

  it("rebuilds the URL Telnyx signed from the relay's public address, or else from the request", () => {
    const requestUrl = "/telephony/telnyx/stream?ticket=abc";
    expect(
      telnyxSignedStreamUrl({
        publicUrl: "https://voice.example.com",
        host: "10.0.0.5:8080",
        encrypted: false,
        requestUrl
      })
    ).toBe("wss://voice.example.com/telephony/telnyx/stream?ticket=abc");
    expect(telnyxSignedStreamUrl({ publicUrl: "http://localhost:8080", encrypted: false, requestUrl })).toBe(
      "ws://localhost:8080/telephony/telnyx/stream?ticket=abc"
    );
    // Without it: the host the request names, secure when the socket is or a proxy says so.
    expect(telnyxSignedStreamUrl({ host: "relay.example.com", encrypted: true, requestUrl })).toBe(
      "wss://relay.example.com/telephony/telnyx/stream?ticket=abc"
    );
    expect(telnyxSignedStreamUrl({ host: "relay.example.com", encrypted: false, requestUrl })).toBe(
      "ws://relay.example.com/telephony/telnyx/stream?ticket=abc"
    );
    expect(
      telnyxSignedStreamUrl({ host: "relay.example.com", forwardedProto: "HTTPS, http", encrypted: false, requestUrl })
    ).toBe("wss://relay.example.com/telephony/telnyx/stream?ticket=abc");
    // The query is part of what is signed: a signature for one ticket is not one for another.
    const signedFor = telnyxSignedStreamUrl({ host: "relay.example.com", encrypted: true, requestUrl });
    const timestamp = String(NOW / 1000);
    const key = telnyxPublicKey(raw.toString("base64"))!;
    const other = telnyxSignedStreamUrl({ host: "relay.example.com", encrypted: true, requestUrl: `${requestUrl}d` });
    expect(
      validTelnyxStreamSignature({
        publicKey: key,
        streamUrl: signedFor,
        timestamp,
        signature: signed(timestamp, signedFor),
        now: NOW
      })
    ).toBe(true);
    expect(
      validTelnyxStreamSignature({
        publicKey: key,
        streamUrl: other,
        timestamp,
        signature: signed(timestamp, signedFor),
        now: NOW
      })
    ).toBe(false);
  });

  it("accepts Telnyx's signature over the timestamp and the exact stream URL", () => {
    const timestamp = String(NOW / 1000);
    const key = telnyxPublicKey(raw.toString("base64"))!;
    const check = (extra: Partial<Parameters<typeof validTelnyxStreamSignature>[0]>) =>
      validTelnyxStreamSignature({
        publicKey: key,
        streamUrl,
        timestamp,
        signature: signed(timestamp),
        now: NOW,
        ...extra
      });
    expect(check({})).toBe(true);
    // Another URL, another ticket, another time, another key, or nothing at all.
    expect(check({ streamUrl: `${streamUrl}d` })).toBe(false);
    expect(check({ timestamp: String(NOW / 1000 + 1) })).toBe(false);
    expect(check({ signature: undefined })).toBe(false);
    expect(check({ timestamp: undefined })).toBe(false);
    expect(check({ signature: "AAAA" })).toBe(false);
    expect(check({ signature: "not base64 at all !!" })).toBe(false);
    expect(check({ publicKey: generateKeyPairSync("ed25519").publicKey })).toBe(false);
  });

  it("refuses a signature that is more than five minutes old, or from the future", () => {
    const key = telnyxPublicKey(raw.toString("base64"))!;
    const at = (seconds: number) => {
      const timestamp = String(NOW / 1000 + seconds);
      return validTelnyxStreamSignature({
        publicKey: key,
        streamUrl,
        timestamp,
        signature: signed(timestamp),
        now: NOW
      });
    };
    expect(at(-299)).toBe(true);
    expect(at(-301)).toBe(false);
    expect(at(301)).toBe(false);
  });
});

describe("parseTelnyxMessage", () => {
  it("reads the documented messages", () => {
    expect(parseTelnyxMessage(JSON.stringify(startMessage()))).toEqual({ event: "start", streamId: STREAM_ID });
    expect(parseTelnyxMessage(JSON.stringify(media(7, 100)))).toEqual({
      event: "media",
      payload: frame(100),
      track: "inbound",
      sequence: 7
    });
    expect(
      parseTelnyxMessage(
        JSON.stringify({
          event: "dtmf",
          stream_id: STREAM_ID,
          occurred_at: "x",
          sequence_number: "5",
          dtmf: { digit: "1" }
        })
      )
    ).toEqual({ event: "dtmf", digit: "1" });
    expect(
      parseTelnyxMessage(
        JSON.stringify({ event: "mark", stream_id: STREAM_ID, sequence_number: "5", mark: { name: "end" } })
      )
    ).toEqual({ event: "mark", name: "end" });
    expect(parseTelnyxMessage(JSON.stringify({ event: "stop", stop: { user_id: "u" }, stream_id: STREAM_ID }))).toEqual(
      {
        event: "stop"
      }
    );
  });

  it("ignores what it cannot use, and never throws", () => {
    for (const raw of [
      "",
      "{",
      "[]",
      JSON.stringify({ event: "connected", version: "1.0.0" }),
      JSON.stringify({ event: "start", start: {} }),
      JSON.stringify({ event: "start", stream_id: "x".repeat(300) }),
      JSON.stringify({ event: "media", media: { payload: "not base64 !" } }),
      JSON.stringify({ event: "media", media: { payload: "A".repeat(70_000) } }),
      JSON.stringify({ event: "dtmf", dtmf: { digit: "12" } }),
      JSON.stringify({ event: "mark", mark: {} })
    ]) {
      expect(parseTelnyxMessage(raw)).toBeUndefined();
    }
    // A track the docs do not name, or a chunk that is not a plain number, is left out, not guessed at.
    for (const chunk of ["x", "", " ", "0x10", "1e3", "-1", 1.5]) {
      expect(
        parseTelnyxMessage(JSON.stringify({ event: "media", media: { payload: "AAAA", track: "both", chunk } }))
      ).toEqual({ event: "media", payload: "AAAA" });
    }
  });

  it("says so when the stream's audio is not what the relay asked for", () => {
    const withFormat = (media_format: unknown) =>
      parseTelnyxMessage(JSON.stringify({ event: "start", start: { media_format }, stream_id: STREAM_ID }));
    expect(withFormat({ encoding: "PCMU", sample_rate: 8000, channels: 1 })).toEqual({
      event: "start",
      streamId: STREAM_ID
    });
    expect(withFormat({ encoding: "PCMU", sample_rate: "8000" })).toEqual({ event: "start", streamId: STREAM_ID });
    expect(withFormat(undefined)).toEqual({ event: "start", streamId: STREAM_ID });
    for (const format of [
      { encoding: "OPUS", sample_rate: 16000, channels: 1 },
      { encoding: "PCMU", sample_rate: 16000, channels: 1 },
      { encoding: "PCMA", sample_rate: 8000, channels: 1 },
      { encoding: "PCMU", sample_rate: 8000, channels: 2 }
    ]) {
      expect(withFormat(format)).toMatchObject({
        event: "start",
        unusable: expect.stringContaining("not PCMU at 8000 Hz")
      });
    }
  });

  it("passes on a problem Telnyx reports, for the log", () => {
    expect(
      parseTelnyxMessage(
        JSON.stringify({
          event: "error",
          payload: { code: 100003, title: "malformed_frame", detail: "The received frame was not formatted correctly." }
        })
      )
    ).toEqual({ event: "problem", detail: "100003 malformed_frame The received frame was not formatted correctly." });
    expect(parseTelnyxMessage(JSON.stringify({ event: "error" }))).toEqual({ event: "problem", detail: "unknown" });
  });
});

describe("a Telnyx call", () => {
  it("refuses a voice webhook without the secret in its URL", () => {
    const { telephony } = setup();
    for (const url of [
      "https://relay.example.com/telephony/telnyx/voice",
      "https://relay.example.com/telephony/telnyx/voice?key=wrong-secret-0123456789abc",
      `https://relay.example.com/telephony/telnyx/voice?key=${SECRET}x`,
      "not a url"
    ]) {
      const response = webhook(telephony, {}, url);
      expect(response.status).toBe(403);
      expect(response.body).not.toContain("<Stream");
    }
  });

  it("answers with TeXML that opens a two-way μ-law stream, with the ticket in its URL", () => {
    const { telephony } = setup();
    const response = webhook(telephony);
    expect(response.status).toBe(200);
    const ticket = ticketOf(response.body);
    expect(response.body).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Connect>' +
        `<Stream url="wss://relay.example.com/telephony/telnyx/stream?ticket=${ticket}" track="inbound_track"` +
        ' codec="PCMU" bidirectionalMode="rtp" bidirectionalCodec="PCMU" bidirectionalSamplingRate="8000"' +
        ' enableReconnect="false"/></Connect></Response>'
    );
    // The secret of the webhook URL does not travel on to the stream URL.
    expect(response.body).not.toContain(SECRET);
    expect(streamTexml("wss://x/y?a=1&b=2")).toContain('url="wss://x/y?a=1&amp;b=2"');
  });

  it("takes Telnyx's call ids, and refuses what is not one", () => {
    const { telephony } = setup();
    expect(webhook(telephony, { CallSid: "bad id with spaces" }).status).toBe(400);
    expect(webhook(telephony, { CallSid: "" }).status).toBe(400);
  });

  it("opens a session for a stream that presents the call's ticket in its URL", async () => {
    const harness = setup();
    const { opened, session, socket } = await connect(harness);
    expect(opened.call).toEqual({ callSid: CALL_SID, direction: "inbound", from: "+14155550111", to: "+14155550100" });
    expect(eventsTo(session).map((event) => event.type)).toEqual(["session.start", "audio.start"]);
    expect(socket.closeCalls).toEqual([]);
    expect(harness.telephony.activeCalls()).toBe(1);
  });

  it("refuses a stream with no ticket, a wrong one, or one that was used already", async () => {
    const harness = setup();
    const response = webhook(harness.telephony);
    for (const ticket of [undefined, "", "someone-elses-ticket"]) {
      const socket = new FakeSocket();
      harness.telephony.handleStream(socket, undefined, ticket);
      socket.telnyx(startMessage());
      expect(socket.closeCalls).toHaveLength(1);
    }
    expect(harness.opened).toHaveLength(0);
    // Looking for a ticket does not use up the real one.
    const first = new FakeSocket();
    harness.telephony.handleStream(first, undefined, ticketOf(response.body));
    first.telnyx(startMessage());
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.opened).toHaveLength(1);
    // Telnyx reconnecting, or anyone replaying the URL, gets nothing.
    const again = new FakeSocket();
    harness.telephony.handleStream(again, undefined, ticketOf(response.body));
    again.telnyx(startMessage());
    expect(again.closeCalls).toHaveLength(1);
    expect(harness.opened).toHaveLength(1);
  });

  it("refuses a stream whose audio it could only turn into noise, and logs what Telnyx reports", async () => {
    const harness = setup();
    const response = webhook(harness.telephony);
    const socket = new FakeSocket();
    harness.telephony.handleStream(socket, undefined, ticketOf(response.body));
    socket.telnyx({
      ...startMessage(),
      start: { media_format: { encoding: "OPUS", sample_rate: 16000, channels: 1 } }
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.opened).toHaveLength(0);
    expect(socket.closeCalls).toHaveLength(1);
    // A problem report before or during a call does not end it.
    const call = await connect(setup());
    call.socket.telnyx({ event: "error", payload: { code: 100003, title: "malformed_frame" } });
    expect(call.socket.closeCalls).toEqual([]);
  });

  it("carries the caller's audio to the session, putting frames that arrive out of order back in order", async () => {
    const { socket, session } = await connect(setup());
    // Each frame holds one level; 3 arrives after 4 and 5.
    for (const chunk of [1, 2, 4, 5, 3, 6]) socket.telnyx(media(chunk, chunk * 1000));
    await vi.advanceTimersByTimeAsync(0);
    const heard = audioTo(session);
    expect(heard).toHaveLength(6);
    expect(heard.every((pcm) => pcm.length === 640)).toBe(true);
    // The level in the middle of each 20 ms frame rises steadily: 1, 2, 3, 4, 5, 6.
    const levels = heard.map((pcm) => pcm.readInt16LE(400));
    for (let i = 1; i < levels.length; i += 1) expect(levels[i]!).toBeGreaterThan(levels[i - 1]! + 400);
    // The relay's own voice coming back on the other track is not the caller.
    socket.telnyx({
      event: "media",
      media: { track: "outbound", chunk: "7", payload: frame(500) },
      stream_id: STREAM_ID
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(audioTo(session)).toHaveLength(6);
  });

  it("sends the assistant's voice, barge-in and marks in Telnyx's own message shapes", async () => {
    const { socket, client } = await connect(setup());
    // 60 ms of assistant audio at 24 kHz.
    client.send(Buffer.alloc(24_000 * 2 * 0.06));
    const sent = socket.ofType("media");
    expect(sent.length).toBeGreaterThanOrEqual(2);
    for (const message of sent) {
      // No stream id, unlike Twilio: { "event": "media", "media": { "payload": … } }.
      expect(Object.keys(message).sort()).toEqual(["event", "media"]);
      expect(Buffer.from((message.media as { payload: string }).payload, "base64")).toHaveLength(160);
    }
    client.send(JSON.stringify({ type: "status", state: "hearing" }));
    expect(socket.messages.at(-1)).toEqual({ event: "clear" });
    // Hanging up waits for a mark to come back, then closes with 1000 so Telnyx does not reconnect.
    client.close(1000, "agent");
    expect(socket.messages.at(-1)).toEqual({ event: "mark", mark: { name: "end" } });
    expect(socket.closeCalls).toEqual([]);
    socket.telnyx({ event: "mark", stream_id: STREAM_ID, sequence_number: "9", mark: { name: "end" } });
    expect(socket.closeCalls).toEqual([{ code: 1000, reason: undefined }]);
  });

  it("passes keypad presses to the assistant, and ends when Telnyx says the stream stopped", async () => {
    const harness = setup();
    const { socket, session } = await connect(harness);
    for (const digit of ["4", "2", "#"]) {
      socket.telnyx({ event: "dtmf", stream_id: STREAM_ID, occurred_at: "t", sequence_number: "3", dtmf: { digit } });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(eventsTo(session).at(-1)).toEqual({ type: "text.input", text: "(keypad) 42" });
    socket.telnyx({
      event: "stop",
      sequence_number: "4",
      stop: { user_id: "u", call_control_id: "c" },
      stream_id: STREAM_ID
    });
    expect(session.close).toHaveBeenCalledTimes(1);
    expect(harness.telephony.activeCalls()).toBe(0);
  });

  it("transfers a call by replacing its TeXML through the REST API", async () => {
    const harness = setup({
      apiKey: "KEY0123",
      accountSid: ACCOUNT,
      phoneNumber: "+14155550100",
      transferTargets: new Map([["support", "+14155550199"]])
    });
    const { opened, client, socket } = await connect(harness);
    const tool = opened.extras.sessionTools.find((candidate) => candidate.name === "transfer_call")!;
    await tool.handler({ destination: "support" }, {} as never);
    client.send(JSON.stringify({ type: "status", state: "speaking" }));
    client.send(JSON.stringify({ type: "status", state: "listening" }));
    socket.telnyx({ event: "mark", stream_id: STREAM_ID, mark: { name: "transfer" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.request).toHaveBeenCalledTimes(1);
    const [url, init] = harness.request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.telnyx.com/v2/texml/Accounts/${ACCOUNT}/Calls/${encodeURIComponent(CALL_SID)}`);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      authorization: "Bearer KEY0123",
      "content-type": "application/x-www-form-urlencoded"
    });
    const form = new URLSearchParams(String(init.body));
    expect([...form.keys()]).toEqual(["Texml"]);
    expect(form.get("Texml")).toContain('<Dial callerId="+14155550100"><Number>+14155550199</Number></Dial>');
  });

  it("offers no transfer tool without the REST credentials", async () => {
    const { opened } = await connect(setup({ transferTargets: new Map([["support", "+14155550199"]]) }));
    expect(opened.extras.sessionTools).toEqual([]);
  });

  it("places an outbound call through the TeXML REST API, and treats its webhook as that call", async () => {
    const harness = setup({
      apiKey: "KEY0123",
      accountSid: ACCOUNT,
      applicationSid: "1234567890",
      phoneNumber: "+14155550100",
      publicUrl: "https://voice.example.com"
    });
    const placed = await harness.telephony.placeCall({ to: "+14155550123", context: "Remind them of Friday." }, "x");
    // Telnyx's documented answer does not name the call.
    expect(placed).toEqual({ ok: true, callSid: "" });
    const [url, init] = harness.request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.telnyx.com/v2/texml/Accounts/${ACCOUNT}/Calls`);
    expect(init.headers).toMatchObject({ authorization: "Bearer KEY0123", "content-type": "application/json" });
    const body = JSON.parse(String(init.body)) as Record<string, string>;
    expect(body).toMatchObject({
      To: "+14155550123",
      From: "+14155550100",
      ApplicationSid: "1234567890",
      UrlMethod: "POST"
    });
    expect(Object.keys(body).sort()).toEqual(["ApplicationSid", "From", "To", "Url", "UrlMethod"]);
    const fetched = new URL(body.Url!);
    expect(`${fetched.origin}${fetched.pathname}`).toBe("https://voice.example.com/telephony/telnyx/voice");
    expect(fetched.searchParams.get("key")).toBe(SECRET);

    // Telnyx fetches the instructions; the stream that follows is the outbound call.
    const response = harness.telephony.voiceWebhook({
      url: body.Url!,
      params: { CallSid: CALL_SID, From: "+14155550100", To: "+14155550123" },
      signature: undefined
    });
    const socket = new FakeSocket();
    harness.telephony.handleStream(socket, undefined, ticketOf(response.body));
    socket.telnyx(startMessage());
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.opened[0]!.call).toMatchObject({
      direction: "outbound",
      to: "+14155550123",
      context: "Remind them of Friday."
    });
    expect(harness.opened[0]!.extras.trustedContext).toContain("You placed this phone call");
  });

  it("uses the call id when Telnyx does send one, and reports a refusal", async () => {
    const withId = setup(
      { apiKey: "K", accountSid: ACCOUNT, applicationSid: "1", phoneNumber: "+14155550100", publicUrl: PUBLIC },
      (async () => jsonResponse({ data: { call_sid: CALL_SID } })) as unknown as typeof fetch
    );
    expect(await withId.telephony.placeCall({ to: "+14155550123" }, "https://r.example")).toEqual({
      ok: true,
      callSid: CALL_SID
    });
    const refused = setup(
      { apiKey: "K", accountSid: ACCOUNT, applicationSid: "1", phoneNumber: "+14155550100", publicUrl: PUBLIC },
      (async () => jsonResponse({ errors: [{ detail: "no" }] }, 422)) as unknown as typeof fetch
    );
    expect(await refused.telephony.placeCall({ to: "+14155550123" }, "https://r.example")).toEqual({
      ok: false,
      status: 502,
      carrierStatus: 422,
      error: "Telnyx refused the call (HTTP 422)."
    });
  });

  it("says what is missing for outbound calls, and that voicemail detection is not there yet", async () => {
    const bare = setup();
    expect(await bare.telephony.placeCall({ to: "+14155550123" }, "https://r.example")).toMatchObject({
      ok: false,
      status: 503,
      error: expect.stringContaining("TELNYX_APPLICATION_SID")
    });
    const ready = setup({
      apiKey: "K",
      accountSid: ACCOUNT,
      applicationSid: "1",
      phoneNumber: "+14155550100",
      publicUrl: PUBLIC
    });
    expect(
      await ready.telephony.placeCall({ to: "+14155550123", voicemailMessage: "Call us back." }, "https://r.example")
    ).toMatchObject({ ok: false, status: 400, error: expect.stringContaining("answering-machine detection") });
    expect(ready.request).not.toHaveBeenCalled();
  });

  it("never sends the webhook secret to an address that the request for a call chose", async () => {
    // Without TELEPHONY_PUBLIC_URL the only address to hand is the one the
    // request came in on, and its sender picks that.
    const harness = setup({ apiKey: "K", accountSid: ACCOUNT, applicationSid: "1", phoneNumber: "+14155550100" });
    expect(await harness.telephony.placeCall({ to: "+14155550123" }, "https://attacker.example")).toEqual({
      ok: false,
      status: 503,
      error: "Set TELEPHONY_PUBLIC_URL to place calls through Telnyx."
    });
    expect(harness.request).not.toHaveBeenCalled();
    // With it, the origin of the request plays no part.
    const safe = setup({
      apiKey: "K",
      accountSid: ACCOUNT,
      applicationSid: "1",
      phoneNumber: "+14155550100",
      publicUrl: PUBLIC
    });
    await safe.telephony.placeCall({ to: "+14155550123" }, "https://attacker.example");
    const [, init] = safe.request.mock.calls[0] as unknown as [string, RequestInit];
    expect(
      (JSON.parse(String(init.body)) as { Url: string }).Url.startsWith(`${PUBLIC}/telephony/telnyx/voice?key=`)
    ).toBe(true);
    expect(String(init.body)).not.toContain("attacker");
  });
});
