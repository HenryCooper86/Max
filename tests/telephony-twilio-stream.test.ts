import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { mulawEncode } from "../server/telephony/g711";
import {
  dialTwiml,
  DtmfCollector,
  hangupTwiml,
  parseTwilioMessage,
  streamTwiml,
  TwilioAudioBridge,
  twilioSignature,
  validTwilioSignature
} from "../server/telephony/twilio-stream";

const media = (payload: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    event: "media",
    streamSid: "MZ1",
    media: { track: "inbound", chunk: "2", timestamp: "5", payload, ...extra }
  });

describe("parseTwilioMessage", () => {
  it("parses each message type", () => {
    expect(parseTwilioMessage('{"event":"connected","protocol":"Call","version":"1.0.0"}')).toEqual({
      event: "connected"
    });
    expect(
      parseTwilioMessage(
        JSON.stringify({
          event: "start",
          start: {
            streamSid: "MZ1",
            callSid: "CA1",
            accountSid: "AC1",
            customParameters: { a: "b" },
            mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 }
          },
          streamSid: "MZ1"
        })
      )
    ).toEqual({ event: "start", streamSid: "MZ1", callSid: "CA1", accountSid: "AC1", customParameters: { a: "b" } });
    expect(parseTwilioMessage(media("AAAA"))).toEqual({ event: "media", payload: "AAAA", track: "inbound" });
    expect(parseTwilioMessage('{"event":"media","media":{"payload":"AAAA"}}')).toEqual({
      event: "media",
      payload: "AAAA"
    });
    expect(
      parseTwilioMessage('{"event":"dtmf","dtmf":{"track":"inbound_track","digit":"#"},"streamSid":"MZ1"}')
    ).toEqual({
      event: "dtmf",
      digit: "#"
    });
    expect(parseTwilioMessage('{"event":"mark","mark":{"name":"x"},"streamSid":"MZ1"}')).toEqual({
      event: "mark",
      name: "x"
    });
    expect(parseTwilioMessage('{"event":"stop","stop":{}}')).toEqual({ event: "stop" });
  });

  it("defaults start without parameters and takes streamSid from the envelope", () => {
    expect(parseTwilioMessage('{"event":"start","start":{"callSid":"CA1"},"streamSid":"MZ9"}')).toEqual({
      event: "start",
      streamSid: "MZ9",
      callSid: "CA1",
      customParameters: {}
    });
  });

  it.each([
    "",
    "not json",
    "null",
    "[]",
    '"x"',
    "{}",
    '{"event":"nope"}',
    '{"event":"start"}',
    '{"event":"start","start":{"streamSid":"MZ1"}}',
    '{"event":"start","start":{"streamSid":"MZ1","callSid":"CA1","customParameters":{"a":1}}}',
    '{"event":"start","start":{"streamSid":"MZ1","callSid":"CA1","customParameters":[]}}',
    '{"event":"media"}',
    '{"event":"media","media":{"payload":5}}',
    '{"event":"media","media":{"payload":"not base64!"}}',
    '{"event":"dtmf","dtmf":{"digit":"E"}}',
    '{"event":"dtmf","dtmf":{"digit":"12"}}',
    '{"event":"dtmf"}',
    '{"event":"mark","mark":{}}',
    '{"event":"mark","mark":{"name":""}}'
  ])("returns undefined for %j", (raw) => {
    expect(parseTwilioMessage(raw)).toBeUndefined();
  });

  it("enforces the size caps", () => {
    expect(parseTwilioMessage(media("A".repeat(64 * 1024)))).toBeDefined();
    expect(parseTwilioMessage(media("A".repeat(64 * 1024 + 4)))).toBeUndefined();
    const start = (customParameters: Record<string, string>) =>
      parseTwilioMessage(
        JSON.stringify({ event: "start", start: { streamSid: "MZ1", callSid: "CA1", customParameters } })
      );
    const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, "v"]));
    expect(start(many(32))).toBeDefined();
    expect(start(many(33))).toBeUndefined();
    expect(start({ ["n".repeat(64)]: "v" })).toBeDefined();
    expect(start({ ["n".repeat(65)]: "v" })).toBeUndefined();
    expect(start({ a: "v".repeat(2048) })).toBeDefined();
    expect(start({ a: "v".repeat(2049) })).toBeUndefined();
  });

  it("accepts every keypad digit", () => {
    for (const digit of "0123456789*#ABCD") {
      expect(parseTwilioMessage(JSON.stringify({ event: "dtmf", dtmf: { digit } }))).toEqual({ event: "dtmf", digit });
    }
  });
});

describe("TwilioAudioBridge", () => {
  const payload = (bytes: number) => Buffer.alloc(bytes, 0xff).toString("base64");

  it("turns each 160-byte payload into exactly one 640-byte frame", () => {
    const bridge = new TwilioAudioBridge("MZ1");
    for (let i = 0; i < 5; i += 1) {
      const frames = bridge.inbound(payload(160), "inbound");
      expect(frames).toHaveLength(1);
      expect(frames[0].length).toBe(640);
    }
  });

  it("carries odd-sized payloads over", () => {
    const bridge = new TwilioAudioBridge("MZ1");
    expect(bridge.inbound(payload(100))).toEqual([]);
    const frames = bridge.inbound(payload(100));
    expect(frames.map((f) => f.length)).toEqual([640]);
    // 200 bytes in = 800 bytes out: one frame emitted, 160 carried; 120 more completes the next.
    expect(bridge.inbound(payload(120)).map((f) => f.length)).toEqual([640]);
  });

  it("ignores audio that is not the caller's", () => {
    const bridge = new TwilioAudioBridge("MZ1");
    expect(bridge.inbound(payload(160), "outbound")).toEqual([]);
    expect(bridge.inbound(payload(160), "inbound")).toHaveLength(1);
  });

  const decoded = (message: string) => {
    const parsed = JSON.parse(message) as { event: string; streamSid: string; media: { payload: string } };
    expect(parsed.event).toBe("media");
    expect(parsed.streamSid).toBe("MZ1");
    return Buffer.from(parsed.media.payload, "base64");
  };

  it("frames outbound audio into 160-byte messages whatever the chunking", () => {
    const bridge = new TwilioAudioBridge("MZ1");
    const total = 24_000 * 2; // one second
    let produced = 0;
    for (const size of [1, 2, 7, 480, 961, 5000, 12345]) {
      for (const message of bridge.outbound(Buffer.alloc(size, 0))) {
        expect(decoded(message).length).toBe(160);
        produced += 1;
      }
    }
    expect(total).toBeGreaterThan(0);
    // 18816 bytes in = 9408 samples = 3136 8 kHz samples = 19 whole frames.
    expect(produced).toBe(19);
  });

  it("flush pads the remainder with mu-law silence", () => {
    const bridge = new TwilioAudioBridge("MZ1");
    expect(bridge.flush()).toEqual([]);
    // 1200 samples at 24 kHz = 400 at 8 kHz = 2 frames + 80 carried.
    const loud = Buffer.alloc(2400);
    for (let i = 0; i < 1200; i += 1) loud.writeInt16LE(i % 2 ? 8000 : -8000, i * 2);
    expect(bridge.outbound(loud)).toHaveLength(2);
    const [last] = bridge.flush();
    const bytes = decoded(last);
    expect(bytes.length).toBe(160);
    expect([...bytes.subarray(80)].every((b) => b === 0xff)).toBe(true);
    expect(bridge.flush()).toEqual([]);
  });

  it("clear returns the clear message and drops the carry", () => {
    const bridge = new TwilioAudioBridge("MZ1");
    bridge.outbound(Buffer.alloc(600));
    expect(JSON.parse(bridge.clear())).toEqual({ event: "clear", streamSid: "MZ1" });
    expect(bridge.flush()).toEqual([]);
  });

  it("builds mark messages", () => {
    expect(JSON.parse(new TwilioAudioBridge("MZ1").mark("end"))).toEqual({
      event: "mark",
      streamSid: "MZ1",
      mark: { name: "end" }
    });
  });

  it("round-trips a tone through outbound then inbound with its level intact", () => {
    const bridge = new TwilioAudioBridge("MZ1");
    const tone = Buffer.alloc(24_000 * 2);
    for (let n = 0; n < 24_000; n += 1)
      tone.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 1000 * n) / 24_000)), n * 2);
    const frames = bridge.outbound(tone).flatMap((m) => bridge.inbound(JSON.parse(m).media.payload));
    expect(frames.length).toBeGreaterThan(40);
    const last = frames[frames.length - 2];
    let sum = 0;
    for (let i = 0; i < last.length / 2; i += 1) sum += last.readInt16LE(i * 2) ** 2;
    const level = Math.sqrt(sum / (last.length / 2));
    expect(level).toBeGreaterThan(0.85 * (8000 / Math.SQRT2));
    expect(level).toBeLessThan(1.1 * (8000 / Math.SQRT2));
    expect(mulawEncode(Buffer.alloc(2)).length).toBe(1);
  });
});

describe("DtmfCollector", () => {
  it("emits after the gap and restarts the timer on each digit", () => {
    vi.useFakeTimers();
    try {
      const seen: string[] = [];
      const collector = new DtmfCollector((d) => seen.push(d), { gapMs: 1000 });
      collector.digit("1");
      vi.advanceTimersByTime(900);
      collector.digit("2");
      vi.advanceTimersByTime(900);
      expect(seen).toEqual([]);
      vi.advanceTimersByTime(100);
      expect(seen).toEqual(["12"]);
      vi.advanceTimersByTime(5000);
      expect(seen).toEqual(["12"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("defaults to a two second gap", () => {
    vi.useFakeTimers();
    try {
      const seen: string[] = [];
      const collector = new DtmfCollector((d) => seen.push(d));
      collector.digit("9");
      vi.advanceTimersByTime(1999);
      expect(seen).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(seen).toEqual(["9"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends at # without including it, and ignores a lone #", () => {
    const seen: string[] = [];
    const collector = new DtmfCollector((d) => seen.push(d), {
      setTimer: vi.fn() as never,
      clearTimer: vi.fn() as never
    });
    collector.digit("#");
    collector.digit("4");
    collector.digit("*");
    collector.digit("#");
    expect(seen).toEqual(["4*"]);
  });

  it("caps a sequence at 32 digits", () => {
    const seen: string[] = [];
    const collector = new DtmfCollector((d) => seen.push(d), {
      setTimer: vi.fn() as never,
      clearTimer: vi.fn() as never
    });
    for (let i = 0; i < 33; i += 1) collector.digit("5");
    expect(seen).toEqual(["5".repeat(32)]);
    collector.flush();
    expect(seen).toEqual(["5".repeat(32), "5"]);
  });

  it("uses injected timers, flush emits, and close drops", () => {
    const setTimer = vi.fn(() => 42 as never);
    const clearTimer = vi.fn();
    const seen: string[] = [];
    const collector = new DtmfCollector((d) => seen.push(d), { setTimer: setTimer as never, clearTimer });
    collector.digit("1");
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 2000);
    collector.digit("2");
    expect(clearTimer).toHaveBeenCalledWith(42);
    collector.flush();
    expect(seen).toEqual(["12"]);
    collector.digit("3");
    collector.close();
    collector.flush();
    expect(seen).toEqual(["12"]);
  });

  it("close stops a pending timer", () => {
    vi.useFakeTimers();
    try {
      const seen: string[] = [];
      const collector = new DtmfCollector((d) => seen.push(d), { gapMs: 100 });
      collector.digit("7");
      collector.close();
      vi.advanceTimersByTime(1000);
      expect(seen).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Twilio signature", () => {
  const token = "12345";
  const url = "https://mycompany.com/myapp.php?foo=1&bar=2";
  const params = { Digits: "1234", To: "+18005551212", From: "+14158675309", Caller: "+14158675309", CallSid: "CA1" };
  // Hand-built: URL, then names and values in name order.
  const signed = `${url}CallSidCA1Caller+14158675309Digits1234From+14158675309To+18005551212`;
  const expected = createHmac("sha1", token).update(signed).digest("base64");

  it("signs the URL plus sorted parameters", () => {
    expect(twilioSignature(token, url, params)).toBe(expected);
    expect(
      twilioSignature(token, url, {
        To: "+18005551212",
        CallSid: "CA1",
        Digits: "1234",
        Caller: "+14158675309",
        From: "+14158675309"
      })
    ).toBe(expected);
  });

  it("verifies a correct header and rejects anything else", () => {
    expect(validTwilioSignature(token, url, params, expected)).toBe(true);
    expect(validTwilioSignature("other", url, params, expected)).toBe(false);
    expect(validTwilioSignature(token, `${url}x`, params, expected)).toBe(false);
    expect(validTwilioSignature(token, url, { ...params, Digits: "1235" }, expected)).toBe(false);
    expect(validTwilioSignature(token, url, { ...params, Extra: "1" }, expected)).toBe(false);
    expect(validTwilioSignature(token, url, params, undefined)).toBe(false);
    expect(validTwilioSignature(token, url, params, "")).toBe(false);
    expect(validTwilioSignature(token, url, params, "short")).toBe(false);
    expect(validTwilioSignature("", url, params, expected)).toBe(false);
  });
});

describe("TwiML", () => {
  const nasty = `a&b<c>d"e'f`;
  const escaped = "a&amp;b&lt;c&gt;d&quot;e&apos;f";

  it("builds a stream with escaped url and parameters", () => {
    expect(streamTwiml("wss://x.example/ws", { a: "b" })).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://x.example/ws"><Parameter name="a" value="b"/></Stream></Connect></Response>'
    );
    const out = streamTwiml(`wss://x/?${nasty}`, { [nasty]: nasty });
    expect(out).toContain(`url="wss://x/?${escaped}"`);
    expect(out).toContain(`<Parameter name="${escaped}" value="${escaped}"/>`);
    expect(streamTwiml("wss://x")).toContain('<Stream url="wss://x"></Stream>');
  });

  it("builds a dial to a number or SIP URI", () => {
    expect(dialTwiml("+14155550100", { callerId: "+14155550123", say: "Hold on", language: "en-US" })).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Say language="en-US">Hold on</Say><Dial callerId="+14155550123"><Number>+14155550100</Number></Dial></Response>'
    );
    expect(dialTwiml("sip:agent@pbx.example.com")).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Dial><Sip>sip:agent@pbx.example.com</Sip></Dial></Response>'
    );
    expect(dialTwiml("sip:a@b.c?x=1&y=2", { say: nasty, callerId: nasty })).toContain("sip:a@b.c?x=1&amp;y=2");
    expect(dialTwiml("+14155550100", { say: nasty, callerId: nasty })).toContain(
      `<Say>${escaped}</Say><Dial callerId="${escaped}">`
    );
  });

  it.each([
    "",
    "14155550100",
    "+0123456",
    "+123456",
    "+1234567890123456",
    "+1415 5550100",
    "tel:+14155550100",
    "sip:",
    "sip:a b@c",
    "sip:<a@b>",
    "<Number>"
  ])("dialTwiml rejects %j", (destination) => {
    expect(() => dialTwiml(destination)).toThrow();
  });

  it("builds a hangup with escaped speech", () => {
    expect(hangupTwiml()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    expect(hangupTwiml(nasty, "de-DE")).toBe(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Say language="de-DE">${escaped}</Say><Hangup/></Response>`
    );
  });
});
