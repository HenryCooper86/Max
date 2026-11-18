import { describe, expect, it } from "vitest";
import {
  MAX_CLIENT_TOOLS,
  MAX_TOOL_DESCRIPTION,
  MAX_TOOL_OUTPUT_CHARS,
  clientToolSpecsFrom,
  parseToolArguments,
  toolErrorText,
  toolOutputText,
  toolSpecFrom
} from "../server/tools/schema";

describe("toolSpecFrom", () => {
  it("trims, defaults parameters and keeps a valid schema", () => {
    expect(toolSpecFrom({ name: " a_b-1 ", description: " does x " }).spec).toEqual({
      name: "a_b-1",
      description: "does x",
      parameters: { type: "object", properties: {} }
    });
    const parameters = { properties: { id: { type: "string" } }, required: ["id"] };
    expect(toolSpecFrom({ name: "t", description: "d", parameters }).spec?.parameters).toEqual({
      type: "object",
      ...parameters
    });
    expect(toolSpecFrom({ name: "t", description: "d", parameters: null }).spec?.parameters).toEqual({
      type: "object",
      properties: {}
    });
  });

  it.each([
    [null, "object"],
    [[], "object"],
    [{ name: "1bad", description: "d" }, "invalid tool name"],
    [{ name: "has space", description: "d" }, "invalid tool name"],
    [{ name: "a".repeat(65), description: "d" }, "invalid tool name"],
    [{ description: "d" }, "invalid tool name"],
    [{ name: "t", description: "  " }, "needs a description"],
    [{ name: "t", description: "x".repeat(MAX_TOOL_DESCRIPTION + 1) }, "longer than"],
    [{ name: "t", description: "d", parameters: "nope" }, "JSON Schema object"],
    [{ name: "t", description: "d", parameters: [] }, "JSON Schema object"],
    [{ name: "t", description: "d", parameters: { type: "string" } }, 'type: "object"'],
    [{ name: "t", description: "d", parameters: { blob: "x".repeat(9000) } }, "larger than 8 KiB"]
  ])("rejects %j", (raw, fragment) => {
    const result = toolSpecFrom(raw);
    expect(result.spec).toBeUndefined();
    expect(result.problem).toContain(fragment);
  });

  it("accepts a 64 char name and a 1024 char description", () => {
    expect(toolSpecFrom({ name: "a".repeat(64), description: "x".repeat(MAX_TOOL_DESCRIPTION) }).spec).toBeTruthy();
  });

  it("rejects parameters that are not JSON", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(toolSpecFrom({ name: "t", description: "d", parameters: circular }).problem).toContain("not JSON");
  });
});

describe("clientToolSpecsFrom", () => {
  it("returns clean specs", () => {
    expect(clientToolSpecsFrom([{ name: "go", description: "Go" }])).toEqual([
      { name: "go", description: "Go", parameters: { type: "object", properties: {} } }
    ]);
  });

  it("throws on non-arrays, invalid tools, duplicates and too many", () => {
    expect(() => clientToolSpecsFrom("x")).toThrow("expected an array");
    expect(() => clientToolSpecsFrom([{ name: "bad name", description: "d" }])).toThrow("Invalid tools");
    expect(() =>
      clientToolSpecsFrom([
        { name: "a", description: "d" },
        { name: "a", description: "d" }
      ])
    ).toThrow("duplicate tool a");
    const many = Array.from({ length: MAX_CLIENT_TOOLS + 1 }, (_, index) => ({ name: `t${index}`, description: "d" }));
    expect(() => clientToolSpecsFrom(many)).toThrow("at most 32");
    expect(clientToolSpecsFrom(many.slice(0, MAX_CLIENT_TOOLS))).toHaveLength(MAX_CLIENT_TOOLS);
  });
});

describe("toolOutputText", () => {
  it("passes strings through and serialises other values", () => {
    expect(toolOutputText("hi")).toBe("hi");
    expect(toolOutputText({ a: 1 })).toBe('{"a":1}');
    expect(toolOutputText(5)).toBe("5");
    expect(toolOutputText(undefined)).toBe('{"ok":true}');
    expect(toolOutputText(() => 1)).toBe('{"ok":true}');
  });

  it("falls back to String() for unserialisable values", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(toolOutputText(circular)).toBe("[object Object]");
    expect(toolOutputText(1n)).toBe("1");
  });

  it("truncates long output", () => {
    const text = toolOutputText("x".repeat(MAX_TOOL_OUTPUT_CHARS + 10));
    expect(text.endsWith("…[truncated]")).toBe(true);
    expect(text.length).toBe(MAX_TOOL_OUTPUT_CHARS + "…[truncated]".length);
    expect(toolOutputText("x".repeat(MAX_TOOL_OUTPUT_CHARS))).toHaveLength(MAX_TOOL_OUTPUT_CHARS);
  });
});

describe("toolErrorText", () => {
  it("wraps and caps the message", () => {
    expect(JSON.parse(toolErrorText("boom"))).toEqual({ error: "boom" });
    expect(JSON.parse(toolErrorText("x".repeat(900))).error).toHaveLength(500);
  });
});

describe("parseToolArguments", () => {
  it("accepts objects, JSON text and empty values", () => {
    expect(parseToolArguments({ a: 1 })).toEqual({ a: 1 });
    expect(parseToolArguments('{"a":1}')).toEqual({ a: 1 });
    expect(parseToolArguments("")).toEqual({});
    expect(parseToolArguments("  ")).toEqual({});
    expect(parseToolArguments(undefined)).toEqual({});
    expect(parseToolArguments(null)).toEqual({});
  });

  it("rejects non-objects and invalid JSON", () => {
    expect(() => parseToolArguments("[1]")).toThrow("JSON object");
    expect(() => parseToolArguments("5")).toThrow("JSON object");
    expect(() => parseToolArguments("null")).toThrow("JSON object");
    expect(() => parseToolArguments(5)).toThrow("JSON object");
    expect(() => parseToolArguments([1])).toThrow("JSON object");
    expect(() => parseToolArguments("{nope")).toThrow();
  });
});
