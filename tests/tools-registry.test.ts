import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildServerTools,
  installServerTools,
  loadToolsModule,
  serverToolProblems,
  serverTools,
  setServerToolsForTests
} from "../server/tools/registry";

const fixture = (name: string) => path.resolve(__dirname, "fixtures", name);
const hook = (name: string, url = "https://a.example.com/x") => ({
  name,
  description: `${name} tool`,
  webhook: { url }
});

afterEach(() => setServerToolsForTests());

describe("buildServerTools", () => {
  it("builds webhook tools and reports bad entries", async () => {
    const { tools, problems } = await buildServerTools({
      tools: [hook("one"), { name: "bad name", description: "d" }, hook("two", "http://example.com/x")]
    });
    expect(tools.map((tool) => tool.name)).toEqual(["one"]);
    expect(problems).toHaveLength(2);
  });

  it("reports a non-array tools value", async () => {
    expect((await buildServerTools({ tools: { a: 1 } })).problems).toEqual(["tools must be an array"]);
    expect(await buildServerTools({})).toMatchObject({ tools: [], problems: [], unreachable: [] });
  });

  it("loads code tools from a module, trimming names and skipping bad entries", async () => {
    const { tools, problems } = await buildServerTools({ modulePath: fixture("agent-tools.ts") });
    expect(tools.map((tool) => tool.name)).toEqual(["echo_tool", "spaced_ok"]);
    expect(tools[1].description).toBe("Name gets trimmed.");
    expect(tools[0].parameters).toEqual({ type: "object", properties: { text: { type: "string" } } });
    expect(problems).toHaveLength(2);
    expect(problems.join("\n")).toContain("invalid tool name");
    expect(problems.join("\n")).toContain("needs a name and a handler");
    const context = {
      callId: "c",
      sessionId: "s",
      signal: new AbortController().signal,
      log: { info() {}, warn() {} }
    };
    expect(await tools[0].handler({ text: "hi" }, context)).toEqual({ echoed: "hi" });
  });

  it("merges module and webhook tools; the first definition of a name wins", async () => {
    const { tools, problems } = await buildServerTools({
      modulePath: fixture("agent-tools.ts"),
      tools: [hook("echo_tool"), hook("remote")]
    });
    expect(tools.map((tool) => tool.name)).toEqual(["echo_tool", "spaced_ok", "remote"]);
    expect(tools[0].description).toBe("Echoes its arguments.");
    expect(problems.some((problem) => problem.includes("echo_tool is defined twice"))).toBe(true);
  });

  it("survives a missing, throwing or wrongly shaped module", async () => {
    const missing = await buildServerTools({ modulePath: fixture("does-not-exist.ts"), tools: [hook("remote")] });
    expect(missing.tools.map((tool) => tool.name)).toEqual(["remote"]);
    expect(missing.problems[0]).toContain("failed to load");
    expect((await loadToolsModule(fixture("broken-tools.ts"))).problems[0]).toContain("fixture exploded");
    expect((await loadToolsModule(fixture("not-array-tools.ts"))).problems[0]).toContain("must export an array");
  });
});

describe("installServerTools", () => {
  it("installs tools and problems for the session to read", async () => {
    await installServerTools({ tools: [hook("one"), { nope: true }] });
    expect(serverTools().map((tool) => tool.name)).toEqual(["one"]);
    expect(serverToolProblems()).toHaveLength(1);
    setServerToolsForTests();
    expect(serverTools()).toEqual([]);
    expect(serverToolProblems()).toEqual([]);
  });
});
