import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_STUDIO } from "../shared/cloud-studio";
import { LanguageProvider } from "../src/components/LanguageToggle";
import type { Project } from "../src/console/api";
import {
  countSummary,
  deliveryLine,
  formatDuration,
  HistoryTab,
  sourceLabel,
  toolLine
} from "../src/console/studio/HistoryTab";
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

describe("how a delivery to the project's server went", () => {
  it("is said in a line", () => {
    expect(deliveryLine({ ok: true, attempts: 1, status: 200 }, en)).toBe("Delivered · HTTP 200");
    expect(deliveryLine({ ok: false, attempts: 4, status: 500, error: "HTTP 500" }, en)).toBe(
      "Not delivered after 4 tries: HTTP 500"
    );
    expect(deliveryLine({ ok: false, attempts: 1, status: 401 }, en)).toBe("Not delivered: HTTP 401");
    expect(deliveryLine({ ok: false, attempts: 0, error: "the signing secret could not be read" }, en)).toBe(
      "Not delivered: the signing secret could not be read"
    );
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
    // The address conversations are sent to: empty, and nothing to test yet.
    expect(html).toContain('id="cxsHistoryWebhook"');
    expect(html).not.toContain("发送测试请求");

    const render = (savedAddress: string, typed: string) => {
      const withAddress = {
        ...project,
        studio: { ...structuredClone(DEFAULT_STUDIO), conversationWebhook: savedAddress }
      } as unknown as Project;
      const draft = draftFromProject(withAddress);
      draft.studio.conversationWebhook = typed;
      return renderToStaticMarkup(
        createElement(
          LanguageProvider,
          null,
          createElement(HistoryTab, { ...props, project: withAddress, draft, dirty: savedAddress !== typed })
        )
      );
    };
    // Saved: it can be tested, and the signing secret is one click away.
    const saved = render("https://shop.example.com/hook", "https://shop.example.com/hook");
    expect(saved).toContain("发送测试请求");
    expect(saved).toContain("查看签名密钥");
    expect(saved).not.toContain("请保存以生效");
    // Changed and not saved: the test would go to the old address, so it waits.
    const changed = render("https://shop.example.com/hook", "https://shop.example.com/other");
    expect(changed).toContain("请保存以生效");
    expect(changed).toMatch(/<button[^>]*disabled=""[^>]*>发送测试请求/);
    // An address Max will not call is said to be one before it is saved.
    const wrong = render("", "http://10.0.0.5/hook");
    expect(wrong).toContain("这个地址不能用");
    expect(wrong).toContain('aria-invalid="true"');
    expect(wrong).not.toContain("请保存以生效");
  });
});
