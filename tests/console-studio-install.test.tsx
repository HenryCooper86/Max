import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_STUDIO } from "../shared/cloud-studio";
import { LanguageProvider } from "../src/components/LanguageToggle";
import { InstallTab } from "../src/console/studio/InstallTab";
import {
  FRAMEWORKS,
  escapeAttribute,
  frameworkSnippets,
  mintTokenCurl,
  publicEmbedSnippet
} from "../src/console/studio/install-snippets";
import type { StudioTabProps } from "../src/console/studio/types";

const ORIGIN = "https://max.example.net";
const PUBLIC_ID = "pub_0123456789abcdef01234567";
const WIDGET = { label: "", accent: "", position: "bottom-right" as const };

describe("install snippets", () => {
  it("builds the one-line embed with origin and public id", () => {
    const text = publicEmbedSnippet(`${ORIGIN}/`, PUBLIC_ID, WIDGET);
    expect(text).toBe(
      `<script src="${ORIGIN}/sdk/voice-agent.iife.js" data-relay="${ORIGIN}" data-project="${PUBLIC_ID}"></script>`
    );
  });

  it("adds label and accent, escaping quotes and angle brackets", () => {
    const text = publicEmbedSnippet(ORIGIN, PUBLIC_ID, {
      label: `Ask "Max" <now>`,
      accent: "#2fd08a",
      position: "bottom-left"
    });
    expect(text).toContain(`data-label="Ask &quot;Max&quot; &lt;now&gt;"`);
    expect(text).toContain(`data-accent="#2fd08a"`);
    expect(text).not.toContain("<now>");
    expect(text).toContain(`data-position="bottom-left"`);
    expect(publicEmbedSnippet(ORIGIN, PUBLIC_ID, WIDGET)).not.toContain("data-position");
  });

  it("ignores a malformed accent", () => {
    expect(publicEmbedSnippet(ORIGIN, PUBLIC_ID, { ...WIDGET, accent: `red" onload="x` })).not.toContain("data-accent");
  });

  it("escapes attribute characters", () => {
    expect(escapeAttribute(`a&b"c'd<e>`)).toBe("a&amp;b&quot;c&#39;d&lt;e&gt;");
  });

  it("points every framework at the relay and keeps the key in the environment", () => {
    for (const name of FRAMEWORKS) {
      const snippets = frameworkSnippets(name, ORIGIN);
      expect(snippets.server).not.toMatch(/mpk_/);
      if (name !== "react") expect(snippets.server).toContain(`${ORIGIN}/v1/session-tokens`);
      expect(snippets.server + snippets.client).toMatch(/MAX_PROJECT_KEY|\/api\/voice-token/);
      expect(snippets.client).toContain("max.example.net");
    }
    expect(frameworkSnippets("next", ORIGIN).server).toContain("process.env.MAX_PROJECT_KEY");
    expect(frameworkSnippets("flask", ORIGIN).server).toContain(`os.environ["MAX_PROJECT_KEY"]`);
    expect(frameworkSnippets("react", ORIGIN).client).toContain("max-voice-agent/react");
    expect(mintTokenCurl(ORIGIN)).toContain(`${ORIGIN}/v1/session-tokens`);
  });
});

describe("InstallTab", () => {
  it("renders the three sections", () => {
    const studio = structuredClone(DEFAULT_STUDIO);
    studio.publicEmbed = { enabled: true, origins: ["http://localhost:5173"] };
    const props = {
      project: { id: "p1", publicId: PUBLIC_ID, studio: DEFAULT_STUDIO },
      draft: { studio },
      dirty: true,
      origin: ORIGIN,
      updateStudio: () => undefined
    } as unknown as StudioTabProps;
    const html = renderToStaticMarkup(createElement(LanguageProvider, null, createElement(InstallTab, props)));
    expect(html).toContain("最简单：粘贴一行代码");
    expect(html).toContain(PUBLIC_ID);
    expect(html).toContain("先保存才会生效。");
    expect(html).toContain('role="tablist"');
    expect(html).toContain("http://localhost:5173");
  });
});
