import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_STUDIO, type StudioTool } from "../shared/cloud-studio";
import { LanguageProvider } from "../src/components/LanguageToggle";
import type { Project } from "../src/console/api";
import { ToolsTab } from "../src/console/studio/ToolsTab";
import {
  coerceSampleArgs,
  exampleRequest,
  parseOptions,
  sanitizeToolName,
  savedUnchanged,
  toolFromSuggestion,
  truncateJson
} from "../src/console/studio/tools-helpers";
import { draftFromProject } from "../src/console/studio/types";
import { AGENT_TEMPLATES } from "../src/lib/agent-templates";

const tool: StudioTool = {
  name: "check_order",
  description: "Look up an order.",
  url: "https://example.com/order",
  parameters: [
    { name: "orderId", type: "string", description: "", required: true, options: [] },
    { name: "count", type: "number", description: "", required: false, options: [] },
    { name: "rush", type: "boolean", description: "", required: false, options: [] }
  ]
};

describe("tool helpers", () => {
  it("sanitizes names", () => {
    expect(sanitizeToolName("Check Order-Status!")).toBe("check_order_status");
    expect(sanitizeToolName("9lives")).toBe("lives");
    expect(sanitizeToolName("x".repeat(80))).toHaveLength(48);
  });

  it("coerces sample values", () => {
    expect(coerceSampleArgs(tool.parameters, { orderId: "A1", count: "3", rush: "yes" }).args).toEqual({
      orderId: "A1",
      count: 3,
      rush: true
    });
    const bad = coerceSampleArgs(tool.parameters, { count: "abc" });
    expect(bad.missing).toEqual(["orderId"]);
    expect(bad.invalid).toEqual(["count"]);
  });

  it("converts a suggestion in the chosen language", () => {
    const suggestion = AGENT_TEMPLATES.flatMap((template) => template.tools)[0];
    if (!suggestion) return;
    const zh = toolFromSuggestion(suggestion, "zh");
    expect(zh.url).toBe("");
    expect(zh.description).toBe(suggestion.description.zh);
    expect(zh.parameters).toHaveLength(suggestion.parameters.length);
  });

  it("builds an example request", () => {
    const body = JSON.parse(exampleRequest(tool));
    expect(body.tool).toBe("check_order");
    expect(body.arguments).toEqual({ orderId: "example", count: 1, rush: true });
    expect(JSON.parse(exampleRequest()).tool).toBe("check_order");
  });

  it("parses options, truncates and compares", () => {
    expect(parseOptions("a, b,, c")).toEqual(["a", "b", "c"]);
    expect(truncateJson("x".repeat(5000)).length).toBeLessThan(2100);
    expect(savedUnchanged(tool, [structuredClone(tool)])).toBe(true);
    expect(savedUnchanged({ ...tool, url: "https://x.dev" }, [tool])).toBe(false);
  });
});

describe("ToolsTab", () => {
  it("renders", () => {
    const project = {
      id: "p1",
      name: "Demo",
      backend: "openai",
      hasWebhookSecret: true,
      studio: { ...structuredClone(DEFAULT_STUDIO), tools: [tool] }
    } as unknown as Project;
    const html = renderToStaticMarkup(
      createElement(
        LanguageProvider,
        null,
        createElement(ToolsTab, {
          session: { api: {}, token: "t", fail: () => "x" } as never,
          project,
          draft: draftFromProject(project),
          update: () => {},
          updateStudio: () => {},
          dirty: false,
          save: async () => true,
          origin: "https://max.example",
          goTo: () => {},
          onProjectChanged: () => {}
        })
      )
    );
    expect(html).toContain("check_order");
    expect(html).toMatch(/Signing secret|签名密钥/);
    expect(html).toMatch(/What your server receives|你的服务器会收到什么/);
  });
});
