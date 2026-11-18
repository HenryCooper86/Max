import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_STUDIO } from "../shared/cloud-studio";
import { LanguageProvider } from "../src/components/LanguageToggle";
import type { Project } from "../src/console/api";
import { countSummary, formatDuration, HistoryTab, sourceLabel, toolLine } from "../src/console/studio/HistoryTab";
import { draftFromProject, type StudioTabProps } from "../src/console/studio/types";

const en = (_zh: string, english: string) => english;

describe("history helpers", () => {
  it("formats durations as m:ss", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(7)).toBe("0:07");
    expect(formatDuration(725)).toBe("12:05");
    expect(formatDuration(-3)).toBe("0:00");
    expect(formatDuration(Number.NaN)).toBe("0:00");
  });

  it("names sources", () => {
    expect(sourceLabel("test", en)).toBe("Test");
    expect(sourceLabel("embed", en)).toBe("Website");
    expect(sourceLabel("api", en)).toBe("API");
  });

  it("summarises counts", () => {
    expect(countSummary(12, en)).toBe("12 conversations in the last 30 days");
    expect(countSummary(1, en)).toBe("1 conversation in the last 30 days");
  });

  it("writes tool lines", () => {
    expect(toolLine({ text: "check_order", ok: true, ms: 412 }, en)).toBe("✓ check_order · 412 ms");
    expect(toolLine({ text: "check_order", ok: false }, en)).toBe("✗ check_order failed");
    expect(toolLine({ text: "check_order: timeout", ok: false }, en)).toBe("✗ check_order failed: timeout");
  });
});

describe("HistoryTab", () => {
  it("renders loading state and the keep setting", () => {
    const project = {
      id: "p1",
      name: "Demo",
      studio: structuredClone(DEFAULT_STUDIO)
    } as unknown as Project;
    const props = {
      session: { api: {}, token: "t", fail: () => "" },
      project,
      draft: draftFromProject(project),
      update: () => undefined,
      updateStudio: () => undefined,
      dirty: false,
      save: async () => true,
      origin: "https://example.test",
      goTo: () => undefined,
      onProjectChanged: () => undefined
    } as unknown as StudioTabProps;
    const html = renderToStaticMarkup(createElement(LanguageProvider, null, createElement(HistoryTab, props)));
    expect(html).toContain("aria-live");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("cxsHistory");
  });
});
