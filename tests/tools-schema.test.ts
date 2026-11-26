import { describe, expect, it } from "vitest";
import {
  MAX_CLIENT_TOOLS,
  MAX_TOOL_DESCRIPTION,
  MAX_TOOL_OUTPUT_BYTES,
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

  it("keeps the background mark, and only when it is set", () => {
    const specs = clientToolSpecsFrom([
      { name: "report", description: "Make a report", background: true },
      { name: "go", description: "Go", background: false }
    ]);
    expect(specs[0]).toMatchObject({ name: "report", background: true });
    expect("background" in specs[1]!).toBe(false);
    expect(() => clientToolSpecsFrom([{ name: "report", description: "d", background: "yes" }])).toThrow(
      "background must be true or false"
    );
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
  const MARK = "…[truncated]";
  const MARK_BYTES = Buffer.byteLength(MARK);
  const budget = MAX_TOOL_OUTPUT_BYTES - MARK_BYTES;

  it("returns exactly 16 KiB of ASCII untouched and caps one byte more, marker included", () => {
    expect(MAX_TOOL_OUTPUT_BYTES).toBe(16 * 1024);
    expect(toolOutputText("x".repeat(MAX_TOOL_OUTPUT_BYTES))).toHaveLength(MAX_TOOL_OUTPUT_BYTES);
    const cut = toolOutputText("x".repeat(MAX_TOOL_OUTPUT_BYTES + 1));
    expect(cut).toBe("x".repeat(budget) + MARK);
    expect(Buffer.byteLength(cut)).toBe(MAX_TOOL_OUTPUT_BYTES);
    expect(Buffer.byteLength(toolOutputText({ rows: "x".repeat(40_000) }))).toBe(MAX_TOOL_OUTPUT_BYTES);
  });

  it("caps by bytes, not characters: output of three-byte characters is cut to a third of the count", () => {
    const exact = "€".repeat(MAX_TOOL_OUTPUT_BYTES / 3);
    expect(toolOutputText(exact)).toBe(exact);
    const cut = toolOutputText("€".repeat(MAX_TOOL_OUTPUT_BYTES / 3 + 1));
    expect(cut).toBe("€".repeat(Math.floor(budget / 3)) + MARK);
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_BYTES);
    expect(cut.length).toBeLessThan(MAX_TOOL_OUTPUT_BYTES / 2);
  });

  it("stays inside the cap and keeps whole characters wherever the boundary falls in mixed output", () => {
    // One, two, three, four and three bytes per character: every kind of edge is crossed near the cap.
    const mixed = "aé€😀中".repeat(4000);
    for (let length = 7550; length < 7566; length++) {
      const input = mixed.slice(0, length);
      const output = toolOutputText(input);
      expect(Buffer.byteLength(output)).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_BYTES);
      if (Buffer.byteLength(input) <= MAX_TOOL_OUTPUT_BYTES) {
        expect(output).toBe(input);
        continue;
      }
      const kept = output.slice(0, -MARK.length);
      expect(output.endsWith(MARK)).toBe(true);
      expect(kept).toBe(input.slice(0, kept.length));
      expect(kept.isWellFormed()).toBe(true);
      // Nothing more would have fitted: the next character breaks the cap.
      expect(Buffer.byteLength(kept + String.fromCodePoint(input.codePointAt(kept.length)!) + MARK)).toBeGreaterThan(
        MAX_TOOL_OUTPUT_BYTES
      );
    }
  });

  it("never cuts a character in half", () => {
    // Three bytes, then four-byte characters: the byte boundary falls inside the 4092nd one.
    const text = "€" + "😀".repeat(5000);
    const cut = toolOutputText(text);
    expect(cut).toBe("€" + "😀".repeat(4091) + MARK);
    expect(cut.isWellFormed()).toBe(true);
    expect(Buffer.byteLength(cut)).toBe(3 + 4091 * 4 + MARK_BYTES);
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
