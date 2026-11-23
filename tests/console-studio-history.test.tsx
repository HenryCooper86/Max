import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_ANALYSIS, DEFAULT_STUDIO, type StudioAnalysis } from "../shared/cloud-studio";
import { LanguageProvider } from "../src/components/LanguageToggle";
import type { ConversationAnalysis, Project } from "../src/console/api";
import { AnalysisMarks, AnalysisSetting, AnalysisView, analysisProblem } from "../src/console/studio/AnalysisSetting";
import {
  answerSummary,
  countSummary,
  deliveryLine,
  formatDuration,
  formatWait,
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

describe("how fast the project answers", () => {
  it("is said in seconds, with one decimal", () => {
    expect(formatWait(812)).toBe("0.8");
    expect(formatWait(12_449)).toBe("12.4");
    expect(formatWait(0)).toBe("0.0");
    expect(formatWait(-3)).toBe("0.0");
  });

  it("is the median over the conversations that were timed", () => {
    expect(answerSummary([], en)).toBe("");
    expect(answerSummary([{}, {}], en)).toBe("");
    expect(answerSummary([{ answerMs: 900 }], en)).toBe(
      "An answer usually begins 0.9 s after the visitor's turn ends (the median of 1 conversation)"
    );
    // One slow conversation does not move it.
    expect(answerSummary([{ answerMs: 700 }, {}, { answerMs: 9_000 }, { answerMs: 800 }], en)).toContain(
      "begins 0.8 s after"
    );
    expect(answerSummary([{ answerMs: 700 }, { answerMs: 900 }], en)).toContain("begins 0.8 s after");
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

describe("what conversations are analysed for", () => {
  const project = {
    id: "p1",
    name: "Demo",
    backend: "gemini",
    studio: structuredClone(DEFAULT_STUDIO)
  } as unknown as Project;
  const base = {
    session: { api: {}, token: "t", fail: () => "" },
    update: () => undefined,
    updateStudio: () => undefined,
    dirty: false,
    save: async () => true,
    origin: "https://example.test",
    goTo: () => undefined,
    onProjectChanged: () => undefined
  };
  const render = (analysis: Partial<StudioAnalysis>, studio: Partial<Project["studio"]> = {}) => {
    const draft = draftFromProject(project);
    draft.studio = { ...draft.studio, ...studio, analysis: { ...DEFAULT_ANALYSIS, ...analysis } };
    const props = { ...base, project, draft } as unknown as StudioTabProps;
    return renderToStaticMarkup(createElement(LanguageProvider, null, createElement(AnalysisSetting, props)));
  };

  it("is off until asked for, and says whose bill it is on", () => {
    const off = render({});
    expect(off).toContain("对话结束时分析每段对话");
    // The project's own vendor, by name.
    expect(off).toContain("你自己的 Google 密钥");
    expect(off).not.toContain("cxsAnalysisCriteria");
    expect(off).not.toContain("请保存以生效");
    // On a relay whose operator runs the analysis model, it does not say the customer pays.
    const operated = { ...project, analysisOnOwnKey: false } as unknown as Project;
    const told = renderToStaticMarkup(
      createElement(
        LanguageProvider,
        null,
        createElement(AnalysisSetting, {
          ...base,
          project: operated,
          draft: draftFromProject(operated)
        } as unknown as StudioTabProps)
      )
    );
    expect(told).toContain("运营方提供的模型");
    expect(told).not.toContain("你自己的");
    // A project stored before there was analysis shows the same.
    const old = {
      ...project,
      studio: { ...structuredClone(DEFAULT_STUDIO), analysis: undefined }
    } as unknown as Project;
    const props = { ...base, project: old, draft: draftFromProject(old) } as unknown as StudioTabProps;
    expect(renderToStaticMarkup(createElement(LanguageProvider, null, createElement(AnalysisSetting, props)))).toBe(
      off
    );
  });

  it("shows what to look for once it is on, and what stands in the way of saving", () => {
    const on = render(
      {
        enabled: true,
        sentiment: true,
        successCriteria: "The order status was given.",
        fields: [{ name: "topic", type: "enum", description: "What it was about.", options: ["orders", "returns"] }]
      },
      { keepConversations: true }
    );
    expect(on).toContain("The order status was given.");
    expect(on).toContain('value="topic"');
    expect(on).toContain('value="orders, returns"');
    expect(on).toContain("请保存以生效");
    expect(on).not.toContain("现在还不能保存");
    // Nothing chosen.
    expect(render({ enabled: true, summary: false }, { keepConversations: true })).toContain("没有要找的内容");
    // A choice field with one choice: the server's own reason, and no "save to apply".
    const short = render(
      { enabled: true, fields: [{ name: "topic", type: "enum", description: "x", options: ["orders"] }] },
      { keepConversations: true }
    );
    expect(short).toContain("field topic: enum needs 2 to 20 options");
    expect(short).not.toContain("请保存以生效");
    // On, with no history and no server: the result would be thrown away.
    expect(render({ enabled: true }, { keepConversations: false, conversationWebhook: "" })).toContain(
      "结果没有地方可去"
    );
    expect(
      render({ enabled: true }, { keepConversations: false, conversationWebhook: "https://shop.example.com/hook" })
    ).not.toContain("结果没有地方可去");
  });

  it("finds what the server would refuse", () => {
    expect(analysisProblem({ ...DEFAULT_ANALYSIS, enabled: true })).toBeUndefined();
    expect(analysisProblem({ ...DEFAULT_ANALYSIS, enabled: true, summary: false })).toBe("nothing to look for");
    expect(
      analysisProblem({ ...DEFAULT_ANALYSIS, enabled: true, summary: false, successCriteria: "It worked." })
    ).toBeUndefined();
    expect(
      analysisProblem({
        ...DEFAULT_ANALYSIS,
        enabled: true,
        fields: [
          { name: "topic", type: "string", description: "x" },
          { name: "topic", type: "string", description: "y" }
        ]
      })
    ).toMatch(/topic/);
  });

  it("shows a conversation's result, its marks, and why there is none", () => {
    const view = (analysis: ConversationAnalysis) =>
      renderToStaticMarkup(createElement(LanguageProvider, null, createElement(AnalysisView, { analysis })));
    const done = view({
      at: 1,
      result: {
        summary: "Asked about <b>order</b> A-1042.",
        sentiment: "positive",
        success: false,
        successReason: "No status was given.",
        data: { order_number: "A-1042", wants_refund: false, items: 2, city: null }
      }
    });
    // What a model wrote is text, never markup.
    expect(done).toContain("Asked about &lt;b&gt;order&lt;/b&gt; A-1042.");
    expect(done).toContain("未成功：No status was given.");
    expect(done).toMatch(/<dt>order_number<\/dt><dd>A-1042<\/dd>/);
    expect(done).toMatch(/<dt>wants_refund<\/dt><dd>否<\/dd>/);
    expect(done).toMatch(/<dt>items<\/dt><dd>2<\/dd>/);
    expect(done).toMatch(/<dt>city<\/dt><dd class="cxMuted">（对话中没有提到）<\/dd>/);
    expect(view({ at: 1, error: "analysis model answered HTTP 401" })).toContain(
      "这段对话没有分析结果：analysis model answered HTTP 401"
    );
    const marks = (props: { sentiment?: "positive" | "neutral" | "negative"; success?: boolean }) =>
      renderToStaticMarkup(createElement(LanguageProvider, null, createElement(AnalysisMarks, props)));
    expect(marks({})).toBe("");
    expect(marks({ success: true, sentiment: "negative" })).toBe(
      '<span class="cxsHistoryBadge good">成功</span><span class="cxsHistoryBadge bad">不满</span>'
    );
    expect(marks({ success: false })).toContain("未成功");
    expect(marks({ sentiment: "neutral" })).toBe('<span class="cxsHistoryBadge ">一般</span>');
  });
});
