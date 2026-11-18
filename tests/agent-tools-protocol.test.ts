import { describe, expect, it } from "vitest";
import { parseClientEvent } from "../server/session-controller";

const parse = (value: unknown) => parseClientEvent(Buffer.from(JSON.stringify(value)));
const start = (extra: Record<string, unknown> = {}) => ({
  type: "session.start",
  sampleRate: 16000,
  channels: 1,
  ...extra
});

describe("text.input", () => {
  it("trims the text", () => {
    expect(parse({ type: "text.input", text: "  hello  " })).toEqual({ type: "text.input", text: "hello" });
  });

  it("rejects empty, blank, non-string and over-long text", () => {
    for (const text of ["", "   ", 5, null, undefined, "x".repeat(2001)]) {
      expect(() => parse({ type: "text.input", text }), String(text)).toThrow("Invalid text.input text");
    }
    expect(parse({ type: "text.input", text: "x".repeat(2000) })).toMatchObject({ type: "text.input" });
  });
});

describe("tool.result", () => {
  it("requires a callId", () => {
    for (const callId of [undefined, "", 5, "x".repeat(129)]) {
      expect(() => parse({ type: "tool.result", callId }), String(callId)).toThrow("Invalid tool.result callId");
    }
  });

  it("keeps output of any shape and omits it when absent", () => {
    expect(parse({ type: "tool.result", callId: "c" })).toEqual({ type: "tool.result", callId: "c" });
    expect(parse({ type: "tool.result", callId: "c", output: { a: [1] } })).toEqual({
      type: "tool.result",
      callId: "c",
      output: { a: [1] }
    });
    expect(parse({ type: "tool.result", callId: "c", output: null })).toMatchObject({ output: null });
  });

  it("requires error to be a string, trims it, caps it and drops blanks", () => {
    expect(() => parse({ type: "tool.result", callId: "c", error: 5 })).toThrow("Invalid tool.result error");
    expect(() => parse({ type: "tool.result", callId: "c", error: { m: 1 } })).toThrow("Invalid tool.result error");
    expect(parse({ type: "tool.result", callId: "c", error: "  nope " })).toMatchObject({ error: "nope" });
    expect(parse({ type: "tool.result", callId: "c", error: "x".repeat(5000) })).toMatchObject({
      error: "x".repeat(1000)
    });
    expect(parse({ type: "tool.result", callId: "c", error: "   " })).not.toHaveProperty("error");
  });
});

describe("session.start tools and context", () => {
  it("normalises valid tools, defaulting the parameters", () => {
    const event = parse(
      start({
        tools: [
          { name: " go ", description: " Go somewhere " },
          { name: "find", description: "Find", parameters: { properties: { q: { type: "string" } } } }
        ]
      })
    ) as unknown as { tools: Array<Record<string, unknown>> };
    expect(event.tools).toEqual([
      { name: "go", description: "Go somewhere", parameters: { type: "object", properties: {} } },
      { name: "find", description: "Find", parameters: { type: "object", properties: { q: { type: "string" } } } }
    ]);
  });

  it("rejects an invalid tool name, a duplicate, too many tools and non-arrays", () => {
    expect(() => parse(start({ tools: [{ name: "bad name", description: "d" }] }))).toThrow("Invalid tools");
    expect(() =>
      parse(
        start({
          tools: [
            { name: "a", description: "d" },
            { name: "a", description: "d" }
          ]
        })
      )
    ).toThrow("duplicate");
    const many = Array.from({ length: 33 }, (_, index) => ({ name: `t${index}`, description: "d" }));
    expect(() => parse(start({ tools: many }))).toThrow("at most 32");
    expect(parse(start({ tools: many.slice(0, 32) }))).toMatchObject({ type: "session.start" });
    expect(() => parse(start({ tools: "nope" }))).toThrow("Invalid tools");
  });

  it("accepts an empty tool list", () => {
    expect(parse(start({ tools: [] }))).toMatchObject({ tools: [] });
  });

  it("validates, trims and drops blank context", () => {
    expect(parse(start({ context: "  on the pricing page " }))).toMatchObject({ context: "on the pricing page" });
    expect(parse(start({ context: "x".repeat(2000) }))).toMatchObject({ type: "session.start" });
    expect(() => parse(start({ context: "x".repeat(2001) }))).toThrow("Invalid context");
    expect(() => parse(start({ context: 5 }))).toThrow("Invalid context");
    expect(parse(start({ context: "   " }))).not.toHaveProperty("context");
  });
});
