import { describe, expect, it } from "vitest";
import { extractAsrText, parseDoubaoFrame } from "../server/providers/doubao";

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

  it("rejects frames that are too short", () => {
    expect(() => parseDoubaoFrame(Buffer.alloc(8))).toThrow();
  });

  it("rejects unsupported message types", () => {
    const frame = buildServerFrame(100, "s", Buffer.from("{}"), { messageType: 0b0001 });
    expect(() => parseDoubaoFrame(frame)).toThrow();
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
