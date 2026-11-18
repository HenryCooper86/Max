import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AssistantProvider } from "../src/components/AssistantContext";
import { BrandMark } from "../src/components/VisorVisual";
import { applyBrandFavicon, brandLogoPath, DEFAULT_ASSISTANT, resolveAssistant } from "../src/lib/assistant";

describe("owner logo path", () => {
  it.each([
    ["/brand/logo?v=1a2b3c", "/brand/logo?v=1a2b3c"],
    ["  /brand/logo.svg  ", "/brand/logo.svg"],
    ["/brand/a/b.png", "/brand/a/b.png"]
  ])("accepts %s", (value, expected) => {
    expect(brandLogoPath(value)).toBe(expected);
  });

  it.each([
    "https://evil.example/brand/logo",
    "//evil.example/brand/logo",
    "///evil.example/brand/logo",
    "/\\evil.example/brand/logo",
    "/brand\\..\\admin",
    "/brand/../auth/me",
    "/brand/%2e%2e/auth/me",
    "/brand/",
    "/branding/logo",
    "brand/logo",
    "javascript:alert(1)",
    "data:image/svg+xml,<svg/>",
    "/brand/lo go",
    "/brand/lo\ngo",
    "/brand/lo\tgo",
    "/brand/\u0000logo",
    `/brand/${"x".repeat(600)}`,
    42,
    null
  ])("rejects %j", (value) => {
    expect(brandLogoPath(value)).toBeUndefined();
  });

  it("is carried through resolveAssistant only when valid", () => {
    const base = { ...DEFAULT_ASSISTANT, languages: [] };
    expect(resolveAssistant({ ...base, logoUrl: "/brand/logo?v=9" }).logoUrl).toBe("/brand/logo?v=9");
    expect(resolveAssistant({ ...base, logoUrl: "//cdn.example/logo.png" })).not.toHaveProperty("logoUrl");
  });
});

describe("brand mark", () => {
  it("shows the owner's logo as a decorative image, else Max's hummingbird", () => {
    const withLogo = renderToStaticMarkup(
      <AssistantProvider value={{ ...DEFAULT_ASSISTANT, logoUrl: "/brand/logo?v=1" }}>
        <BrandMark className="loginMark" />
      </AssistantProvider>
    );
    expect(withLogo).toMatch(/<img[^>]*class="brandLogo loginMark"/);
    expect(withLogo).toContain('src="/brand/logo?v=1"');
    expect(withLogo).toContain('alt=""');

    const builtIn = renderToStaticMarkup(<BrandMark className="loginMark" />);
    expect(builtIn).toMatch(/<img[^>]*class="brandLogo loginMark"/);
    expect(builtIn).toMatch(/Hummingbird/);
    expect(builtIn).not.toContain("visorMark");
  });
});

describe("favicon", () => {
  function fakeLink(attributes: Record<string, string>) {
    const attrs = new Map(Object.entries(attributes));
    return {
      dataset: {} as Record<string, string>,
      getAttribute: (name: string) => attrs.get(name) ?? null,
      setAttribute: (name: string, value: string) => attrs.set(name, value),
      removeAttribute: (name: string) => attrs.delete(name),
      attrs
    };
  }

  it("points icon links at the logo and restores the static ones after", () => {
    const ico = fakeLink({ rel: "icon", type: "image/x-icon", sizes: "16x16 32x32 48x48", href: "/favicon.ico" });
    const svg = fakeLink({ rel: "icon", type: "image/svg+xml", sizes: "any", href: "/favicon.svg" });
    const doc = { querySelectorAll: () => [ico, svg] } as unknown as Document;

    applyBrandFavicon(doc, "/brand/logo?v=2");
    for (const link of [ico, svg]) {
      expect(link.attrs.get("href")).toBe("/brand/logo?v=2");
      expect(link.attrs.has("type")).toBe(false);
    }

    applyBrandFavicon(doc, "/brand/logo?v=3");
    applyBrandFavicon(doc, undefined);
    expect(Object.fromEntries(ico.attrs)).toEqual({
      rel: "icon",
      type: "image/x-icon",
      sizes: "16x16 32x32 48x48",
      href: "/favicon.ico"
    });
    expect(svg.attrs.get("href")).toBe("/favicon.svg");
    expect(svg.attrs.get("type")).toBe("image/svg+xml");
  });
});
