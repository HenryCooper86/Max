import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION as RELAY_PROTOCOL_VERSION } from "../shared/agent";
import { PROTOCOL_VERSION, SDK_VERSION } from "../sdk/src/version";
import {
  PcmFramer,
  buildSessionStart,
  downsample,
  float32ToPcm16,
  mergeTranscript,
  parseRelayEvent,
  pcm16ToFloat32,
  reconnectDelayMs,
  relayUrl,
  relayWebRtcUrl,
  serializeTools,
  shouldReconnect,
  type TranscriptItem
} from "../sdk/src/protocol";

describe("relayUrl", () => {
  it("maps http(s) to ws(s) and appends /agent", () => {
    expect(relayUrl("https://relay.example.com")).toBe("wss://relay.example.com/agent");
    expect(relayUrl("http://localhost:8787/")).toBe("ws://localhost:8787/agent");
  });

  it("keeps ws(s) bases and existing /agent paths", () => {
    expect(relayUrl("wss://relay.example.com/agent")).toBe("wss://relay.example.com/agent");
    expect(relayUrl("ws://host/prefix")).toBe("ws://host/prefix/agent");
  });

  it("adds the token, replacing an existing one, and URL-encodes it", () => {
    expect(relayUrl("https://r.example.com", "vst_abc")).toBe("wss://r.example.com/agent?token=vst_abc");
    expect(relayUrl("wss://r.example.com/agent?token=old&x=1", "a b&c")).toBe(
      "wss://r.example.com/agent?token=a+b%26c&x=1"
    );
  });

  it("rejects unusable bases", () => {
    expect(() => relayUrl("ftp://r.example.com")).toThrow(TypeError);
    expect(() => relayUrl("not a url")).toThrow(TypeError);
  });
});

describe("relayWebRtcUrl", () => {
  it("gives the https /agent/webrtc URL for http(s) bases", () => {
    expect(relayWebRtcUrl("https://relay.example.com")).toBe("https://relay.example.com/agent/webrtc");
    expect(relayWebRtcUrl("http://localhost:8787/")).toBe("http://localhost:8787/agent/webrtc");
  });

  it("maps ws(s) bases to http(s), with or without /agent, and keeps a path prefix", () => {
    expect(relayWebRtcUrl("wss://relay.example.com/agent")).toBe("https://relay.example.com/agent/webrtc");
    expect(relayWebRtcUrl("ws://host/prefix")).toBe("http://host/prefix/agent/webrtc");
    expect(relayWebRtcUrl("wss://host/prefix/agent/")).toBe("https://host/prefix/agent/webrtc");
  });

  it("drops the query and hash, so a token in the URL is not sent along", () => {
    expect(relayWebRtcUrl("wss://r.example.com/agent?token=abc#x")).toBe("https://r.example.com/agent/webrtc");
  });

  it("resolves a relative path against the page", () => {
    const before = (globalThis as { location?: unknown }).location;
    (globalThis as { location?: unknown }).location = { href: "https://site.example.com/app/page" };
    try {
      expect(relayWebRtcUrl("/relay")).toBe("https://site.example.com/relay/agent/webrtc");
    } finally {
      (globalThis as { location?: unknown }).location = before;
    }
  });
});

describe("mergeTranscript", () => {
  const event = (turnId: string, speaker: "rider" | "agent", text: string, final?: boolean) => ({
    turnId,
    speaker,
    text,
    ...(final === undefined ? {} : { final })
  });

  it("maps rider to user and agent to agent", () => {
    const a = mergeTranscript([], event("t1", "rider", "hi", true), 1);
    const b = mergeTranscript(a.list, event("t2", "agent", "hello", true), 2);
    expect(b.list.map((item) => item.role)).toEqual(["user", "agent"]);
  });

  it("updates a partial in place until it is final", () => {
    const partial = mergeTranscript([], event("t1", "rider", "turn on", false), 1);
    expect(partial.item).toMatchObject({ id: "t1", text: "turn on", final: false });
    const done = mergeTranscript(partial.list, event("t1", "rider", "turn on the lights", true), 5);
    expect(done.list).toHaveLength(1);
    expect(done.item).toMatchObject({ text: "turn on the lights", final: true, at: 5 });
  });

  it("treats a missing final flag as final", () => {
    expect(mergeTranscript([], event("t1", "agent", "ok"), 1).item?.final).toBe(true);
  });

  it("starts a new item for a new turn and finalizes the dangling partial", () => {
    const first = mergeTranscript([], event("t1", "rider", "wait", false), 1);
    const second = mergeTranscript(first.list, event("t2", "agent", "sure", false), 2);
    expect(second.list).toHaveLength(2);
    expect(second.list[0]!.final).toBe(true);
    expect(second.list[1]!.final).toBe(false);
  });

  it("returns the same list for blank text or an identical repeat", () => {
    const start = mergeTranscript([], event("t1", "agent", "hi", true), 1);
    expect(mergeTranscript(start.list, event("t1", "agent", "   ", true), 2)).toEqual({ list: start.list });
    const repeat = mergeTranscript(start.list, event("t1", "agent", "hi", true), 3);
    expect(repeat.list).toBe(start.list);
    expect(repeat.item).toBeUndefined();
  });

  it("does not mutate its input", () => {
    const list: readonly TranscriptItem[] = Object.freeze([
      Object.freeze({ id: "t1", role: "user" as const, text: "a", final: false, at: 0 })
    ]);
    expect(() => mergeTranscript(list, event("t1", "rider", "ab", true), 1)).not.toThrow();
    expect(list[0]!.text).toBe("a");
  });
});

describe("PCM helpers", () => {
  it("converts float to PCM16 with clamping and asymmetric scale", () => {
    const pcm = float32ToPcm16(Float32Array.of(0, 1, -1, 2, -2, 0.5));
    expect(Array.from(pcm)).toEqual([0, 32767, -32768, 32767, -32768, 16383]);
  });

  it("round-trips through PCM16 within one quantization step", () => {
    const input = Float32Array.of(0.1, -0.25, 0.9, -0.9);
    const back = pcm16ToFloat32(float32ToPcm16(input));
    input.forEach((value, i) => expect(back[i]).toBeCloseTo(value, 3));
  });

  it("downsamples 48 kHz to 16 kHz by averaging", () => {
    const input = Float32Array.of(0, 0.3, 0.6, 1, 1, 1);
    const out = downsample(input, 48000, 16000);
    expect(out).toHaveLength(2);
    expect(out[0]).toBeCloseTo(0.3);
    expect(out[1]).toBeCloseTo(1);
  });

  it("handles fractional ratios (44.1 kHz) and keeps DC level", () => {
    const out = downsample(new Float32Array(4410).fill(0.5), 44100, 16000);
    expect(out).toHaveLength(1600);
    for (const sample of out) expect(sample).toBeCloseTo(0.5, 5);
  });

  it("copies when rates match and refuses to upsample", () => {
    const input = Float32Array.of(1, 2);
    const out = downsample(input, 16000, 16000);
    expect(out).not.toBe(input);
    expect(Array.from(out)).toEqual([1, 2]);
    expect(() => downsample(input, 8000, 16000)).toThrow(RangeError);
  });

  it("frames a stream into 320-sample chunks regardless of block size", () => {
    const framer = new PcmFramer(48000);
    const frames: Int16Array[] = [];
    // 3 x 128 = 384 samples at 48 kHz is 128 at 16 kHz; feed 20 ms * 5 total.
    for (let i = 0; i < (5 * 48000 * 0.02) / 128 + 1; i += 1)
      frames.push(...framer.push(new Float32Array(128).fill(0.5)));
    expect(frames).toHaveLength(5);
    for (const frame of frames) {
      expect(frame).toHaveLength(320);
      expect(frame[0]).toBe(16383);
    }
  });
});

describe("session.start", () => {
  const tools = [
    {
      name: "open_page",
      description: "Open a page",
      parameters: { type: "object", properties: { path: { type: "string" } } },
      handler: () => "ignored"
    },
    { name: "now", description: "Current time" }
  ];

  it("builds the base payload", () => {
    expect(buildSessionStart({})).toEqual({
      type: "session.start",
      sampleRate: 16000,
      channels: 1,
      platform: "web",
      protocol: PROTOCOL_VERSION,
      appVersion: `max-voice-agent@${SDK_VERSION}`
    });
  });

  it("states the package's real version and the relay's protocol", () => {
    const manifest = JSON.parse(readFileSync(new URL("../sdk/package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    expect(SDK_VERSION).toBe(manifest.version);
    expect(PROTOCOL_VERSION).toBe(RELAY_PROTOCOL_VERSION);
    // The relay accepts at most 40 bytes of appVersion.
    expect(Buffer.byteLength(buildSessionStart({}).appVersion)).toBeLessThanOrEqual(40);
  });

  it("includes options and serializes tools without handlers", () => {
    const message = buildSessionStart({
      language: "en",
      voice: "male",
      backend: "openai",
      context: " on pricing ",
      tools
    });
    expect(message).toMatchObject({
      language: "en",
      voiceGender: "male",
      voiceProvider: "openai",
      context: "on pricing"
    });
    expect(message.tools).toEqual([
      {
        name: "open_page",
        description: "Open a page",
        parameters: { type: "object", properties: { path: { type: "string" } } }
      },
      { name: "now", description: "Current time" }
    ]);
    expect(JSON.stringify(message)).not.toContain("handler");
  });

  it("caps context at 2000 characters and tools at 32", () => {
    expect(buildSessionStart({ context: "x".repeat(3000) }).context).toHaveLength(2000);
    const many = Array.from({ length: 40 }, (_, i) => ({ name: `t${i}`, description: "d" }));
    expect(serializeTools(many)).toHaveLength(32);
  });
});

describe("reconnect policy", () => {
  it("backs off exponentially up to 8 s", () => {
    expect([1, 2, 3, 4, 5, 6].map(reconnectDelayMs)).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
  });

  it("never reconnects after an idle close and gives up after 6 attempts", () => {
    expect(shouldReconnect(4001, 1)).toBe(false);
    expect(shouldReconnect(4003, 1)).toBe(false);
    expect(shouldReconnect(1008, 1)).toBe(false);
    expect(shouldReconnect(1006, 1)).toBe(true);
    expect(shouldReconnect(1006, 6)).toBe(true);
    expect(shouldReconnect(1006, 7)).toBe(false);
    expect(shouldReconnect(1006, 1, false)).toBe(false);
  });
});

describe("parseRelayEvent", () => {
  it("accepts known events and drops malformed or unknown ones", () => {
    expect(parseRelayEvent('{"type":"status","state":"hearing"}')).toMatchObject({ type: "status" });
    expect(parseRelayEvent("not json")).toBeUndefined();
    expect(parseRelayEvent('{"type":"mystery"}')).toBeUndefined();
    expect(parseRelayEvent('{"type":"transcript","speaker":"agent"}')).toBeUndefined();
    expect(parseRelayEvent('{"type":"tool.call","callId":"c","name":"n","arguments":5}')).toEqual({
      type: "tool.call",
      callId: "c",
      name: "n",
      arguments: {}
    });
  });
});
