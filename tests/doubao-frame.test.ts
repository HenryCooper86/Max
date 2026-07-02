import { describe, expect, it } from "vitest";
import {
  EventSend,
  buildAudioRequest,
  buildFullClientRequest,
  extractChatText,
  extractAsrText,
  normalizeTranscriptText,
  parseDoubaoFrame
} from "../server/providers/doubao";

function uint32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

// Builds a Doubao server-response frame the way the upstream service does:
// 4-byte header, then big-endian event / session-length / session / payload.
function buildServerFrame(
  event: number,
  sessionId: string,
  payload: Buffer,
  options?: { messageType?: number; serialization?: number }
): Buffer {
  const messageType = options?.messageType ?? 0b1001; // FullServerResponse
  const serialization = options?.serialization ?? 0b0001; // Json
  const header = Buffer.from([0x11, (messageType << 4) | 0b0100, serialization << 4, 0x00]);
  const session = Buffer.from(sessionId);
  return Buffer.concat([header, uint32(event), uint32(session.length), session, uint32(payload.length), payload]);
}

describe("parseDoubaoFrame", () => {
  it("builds a full client-request header and event", () => {
    const frame = buildFullClientRequest(EventSend.StartConnection);

    expect(frame[0]).toBe(0x11);
    expect(frame[1] >> 4).toBe(0b0001);
    expect(frame[2] >> 4).toBe(0b0001);
    expect(frame.readUInt32BE(4)).toBe(EventSend.StartConnection);
  });

  it("builds an audio-only request with raw PCM payload", () => {
    const audio = Buffer.from([9, 8, 7]);
    const frame = buildAudioRequest("abc", audio);

    expect(frame[1] >> 4).toBe(0b0010);
    expect(frame[2] >> 4).toBe(0b0000);
    expect(frame.readUInt32BE(4)).toBe(EventSend.TaskRequest);
    expect(frame.subarray(frame.length - audio.length).equals(audio)).toBe(true);
  });

  it("parses a JSON server-response frame", () => {
    const frame = buildServerFrame(550, "session-abc", Buffer.from(JSON.stringify({ content: "你好" })));
    const parsed = parseDoubaoFrame(frame);
    expect(parsed.event).toBe(550);
    expect(parsed.sessionId).toBe("session-abc");
    expect(JSON.parse(parsed.payload.toString())).toEqual({ content: "你好" });
  });

  it("parses a raw audio-response frame", () => {
    const audio = Buffer.from([1, 2, 3, 4, 5]);
    const frame = buildServerFrame(352, "s", audio, { messageType: 0b1011, serialization: 0b0000 });
    const parsed = parseDoubaoFrame(frame);
    expect(parsed.event).toBe(352);
    expect(parsed.payload.equals(audio)).toBe(true);
  });

  it("parses an error frame's code and payload (no session-id section)", () => {
    // ErrorInformation layout: header + errorCode(4) + payloadSize(4) + payload.
    const payload = Buffer.from(JSON.stringify({ error: "quota exceeded" }));
    const header = Buffer.from([0x11, (0b1111 << 4) | 0b0100, 0b0001 << 4, 0x00]);
    const frame = Buffer.concat([header, uint32(45000001), uint32(payload.length), payload]);

    const parsed = parseDoubaoFrame(frame);
    expect(parsed.errorCode).toBe(45000001);
    expect(JSON.parse(parsed.payload.toString())).toEqual({ error: "quota exceeded" });
  });

  it("rejects compressed frames instead of failing later at JSON.parse", () => {
    const frame = buildServerFrame(550, "s", Buffer.from("{}"));
    frame[2] |= 0b0001; // gzip compression flag
    expect(() => parseDoubaoFrame(frame)).toThrow("compression");
  });

  it("rejects frames that are too short", () => {
    expect(() => parseDoubaoFrame(Buffer.alloc(8))).toThrow();
  });

  it("rejects unsupported message types", () => {
    const frame = buildServerFrame(100, "s", Buffer.from("{}"), { messageType: 0b0001 });
    expect(() => parseDoubaoFrame(frame)).toThrow();
  });

  it("rejects frames with a truncated payload", () => {
    const frame = buildServerFrame(550, "s", Buffer.from(JSON.stringify({ content: "hi" })));
    expect(() => parseDoubaoFrame(frame.subarray(0, frame.length - 2))).toThrow("payload is incomplete");
  });
});

describe("extractAsrText", () => {
  it("joins result text segments", () => {
    expect(extractAsrText({ results: [{ text: "前方" }, { text: "路况良好" }] })).toBe("前方 路况良好");
  });

  it("returns an empty string when results are missing", () => {
    expect(extractAsrText({})).toBe("");
  });
});

describe("extractChatText", () => {
  it("extracts direct chat content", () => {
    expect(extractChatText({ content: "可以，现在显示天气。" })).toBe("可以，现在显示天气。");
  });

  it("extracts nested and choice-style chat content", () => {
    expect(extractChatText({ choices: [{ delta: { content: "天气" } }, { message: { content: "已接入" } }] })).toBe(
      "天气已接入"
    );
  });

  it("stops at the recursion depth limit instead of overflowing on deep payloads", () => {
    // Build a payload nested far beyond the extraction depth limit.
    let payload: Record<string, unknown> = { content: "深处文本" };
    for (let i = 0; i < 5000; i += 1) payload = { data: payload };
    expect(() => extractChatText(payload)).not.toThrow();
    expect(extractChatText(payload)).toBe("");
  });

  it("still extracts text within the allowed nesting depth", () => {
    expect(extractChatText({ data: { response: { message: { content: "正常深度" } } } })).toBe("正常深度");
  });
});

describe("normalizeTranscriptText", () => {
  it("matches English transcript variants with missing spaces", () => {
    expect(normalizeTranscriptText("Sure. Fromnow on, I'll respondin English.")).toBe(
      normalizeTranscriptText("Sure. From now on, I'll respond in English.")
    );
  });
});
