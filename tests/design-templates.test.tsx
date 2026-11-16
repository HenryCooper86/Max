import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/components/LanguageToggle";
import { TemplatePicker } from "../src/components/TemplatePicker";
import { accentTokens, resolveAssistant } from "../src/lib/assistant";
import { contrastRatio, parseColor } from "../src/lib/color";
import { createTranslator, deviceAssistantCopy } from "../src/lib/i18n";
import {
  loadStoredSettings,
  normalizeStoredSettings,
  saveStoredSettings,
  saveStoredAppearance
} from "../src/lib/persistence";
import {
  applyAppearance,
  DEFAULT_TEMPLATE_ID,
  findTemplate,
  resolveAppearance,
  TEMPLATES,
  tokenContrast
} from "../src/lib/templates";
import { COLOR_TOKENS, sanitizeThemeOverrides, TEMPLATE_TOKENS } from "../src/lib/theme-tokens";

const template = (id: string) => findTemplate(id)!;

describe("design templates", () => {
  it("ships the five templates with unique ids, bilingual copy and visor as the default", () => {
    expect(TEMPLATES.map((entry) => entry.id)).toEqual(["visor", "daylight", "beacon", "ember", "holo"]);
    expect(DEFAULT_TEMPLATE_ID).toBe("visor");
    for (const entry of TEMPLATES) {
      expect(entry.label.zh && entry.label.en && entry.description.zh && entry.description.en).toBeTruthy();
    }
    expect(template("daylight").scheme).toBe("light");
    expect(TEMPLATES.filter((entry) => entry.scheme === "dark").map((entry) => entry.id)).toEqual([
      "visor",
      "beacon",
      "ember",
      "holo"
    ]);
  });

  it.each(TEMPLATES.map((entry) => [entry.id, entry] as const))("%s defines every token", (_, entry) => {
    for (const name of TEMPLATE_TOKENS) {
      expect(entry.tokens[name], `${entry.id} --${name}`).toEqual(expect.stringMatching(/\S/));
    }
    for (const name of COLOR_TOKENS) expect(parseColor(entry.tokens[name]), `${entry.id} --${name}`).not.toBeNull();
  });

  it.each(TEMPLATES.map((entry) => [entry.id, entry] as const))(
    "%s keeps text readable on its surfaces",
    (_, entry) => {
      const { tokens } = entry;
      for (const surface of ["bg", "surface-1", "surface-2"] as const) {
        for (const text of ["text", "text-2", "accent", "user", "danger", "warn", "ok"] as const) {
          expect(tokenContrast(tokens, text, surface), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
        // Tertiary text is for hints and timestamps; beacon has none faint.
        expect(tokenContrast(tokens, "text-3", surface)).toBeGreaterThanOrEqual(entry.id === "beacon" ? 7 : 3);
      }
      expect(tokenContrast(tokens, "on-accent", "accent")).toBeGreaterThanOrEqual(4.5);
      expect(tokenContrast(tokens, "on-danger", "danger")).toBeGreaterThanOrEqual(4.5);
      expect(tokenContrast(tokens, "on-warn", "warn")).toBeGreaterThanOrEqual(4.5);
    }
  );

  it("keeps the visor template identical to the stylesheet's :root defaults", () => {
    const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    const root = /:root\s*\{([\s\S]*?)\n\}/.exec(css)![1]!;
    const declared = new Map(
      [...root.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((match) => [match[1]!, match[2]!.replace(/\s+/g, " ").trim()])
    );
    for (const name of TEMPLATE_TOKENS) {
      expect(declared.get(name)?.toLowerCase(), `--${name}`).toBe(template("visor").tokens[name].toLowerCase());
    }
  });

  it("gives beacon a larger type scale, heavier lines and a thicker focus ring", () => {
    const visor = template("visor").tokens;
    const beacon = template("beacon").tokens;
    for (const size of ["fs-12", "fs-13", "fs-15", "fs-17", "fs-22", "fs-32"] as const) {
      expect(parseFloat(beacon[size])).toBeGreaterThan(parseFloat(visor[size]));
    }
    expect(parseFloat(beacon["line-w"])).toBeGreaterThanOrEqual(2);
    expect(parseFloat(beacon["focus-w"])).toBeGreaterThan(parseFloat(visor["focus-w"]));
    expect(beacon.bg).toBe("#000000");
  });
});

describe("relay theme overrides", () => {
  it("keeps allow-listed tokens with safe values", () => {
    expect(
      sanitizeThemeOverrides({
        accent: " #C6F432 ",
        "surface-1": "rgba(0, 0, 0, 0.5)",
        text: "#fff",
        "radius-card": "0.5rem",
        "radius-control": "12",
        "fs-15": "18px",
        glow: "0.4"
      })
    ).toEqual({
      accent: "#c6f432",
      "surface-1": "rgba(0, 0, 0, 0.5)",
      text: "#fff",
      "radius-card": "0.5rem",
      "radius-control": "12px",
      "fs-15": "18px",
      glow: "0.4"
    });
  });

  it("drops unknown names, prefixed names and font stacks", () => {
    expect(
      sanitizeThemeOverrides({
        "--bg": "#000000",
        background: "#000000",
        "font-display": "Comic Sans MS",
        __proto__: { accent: "#000000" }
      })
    ).toEqual({});
  });

  it.each([
    ["bg", "url(javascript:alert(1))"],
    ["bg", "#000; background-image: url(https://example.com/x)"],
    ["accent", "var(--danger)"],
    ["accent", "red"],
    ["accent", "#12345"],
    ["accent", "rgb(300, 0, 0)"],
    ["accent", "hsl(0, 100%, 50%)"],
    ["radius-card", "10vw"],
    ["radius-card", "calc(1px + 1px)"],
    ["radius-card", "999px"],
    ["fs-15", "0px"],
    ["fs-15", "-4px"],
    ["line-w", "40px"],
    ["glow", "2"],
    ["glow", "1e3"],
    ["text", 123]
  ])("rejects %s: %s", (name, value) => {
    expect(sanitizeThemeOverrides({ [name]: value })).toEqual({});
  });

  it("rejects non-object themes", () => {
    expect(sanitizeThemeOverrides("bg: #000")).toEqual({});
    expect(sanitizeThemeOverrides(["#000"])).toEqual({});
    expect(sanitizeThemeOverrides(null)).toEqual({});
  });

  it("is applied by resolveAssistant before anything else sees it", () => {
    const assistant = resolveAssistant({
      name: "Iris",
      device: "glasses",
      wakePhrase: "Iris",
      wakeWordEnabled: true,
      languages: ["en"],
      deviceProfile: "assistive-glasses",
      deviceLabel: "assistive glasses",
      template: "Beacon",
      templateSwitching: false,
      theme: { accent: "#ff0000", bg: "expression(alert(1))" }
    });
    expect(assistant).toMatchObject({
      deviceProfile: "assistive-glasses",
      deviceLabel: "assistive glasses",
      template: "beacon",
      templateSwitching: false,
      theme: { accent: "#ff0000" }
    });
    expect(resolveAssistant({ ...assistant, templateSwitching: true, languages: [] })).not.toHaveProperty(
      "templateSwitching"
    );
  });
});

describe("template precedence", () => {
  it("falls back to visor with nothing from the relay or the viewer", () => {
    const appearance = resolveAppearance({});
    expect(appearance.template.id).toBe("visor");
    expect(appearance.source).toBe("default");
    expect(appearance.tokens).toEqual(template("visor").tokens);
  });

  it("uses the relay's template, then the viewer's own choice over it", () => {
    expect(resolveAppearance({ relayTemplate: "ember" })).toMatchObject({
      template: { id: "ember" },
      source: "relay"
    });
    expect(resolveAppearance({ relayTemplate: "ember", viewerTemplate: "daylight" })).toMatchObject({
      template: { id: "daylight" },
      source: "viewer"
    });
  });

  it("ignores the viewer's choice when the owner pinned the template", () => {
    expect(
      resolveAppearance({ relayTemplate: "beacon", viewerTemplate: "holo", templateSwitching: false }).template.id
    ).toBe("beacon");
  });

  it("ignores template ids it does not know", () => {
    expect(resolveAppearance({ relayTemplate: "neon", viewerTemplate: "plasma" }).template.id).toBe("visor");
    expect(resolveAppearance({ relayTemplate: "neon", viewerTemplate: "holo" }).template.id).toBe("holo");
  });

  it("applies theme overrides on top and re-derives what depends on them", () => {
    const { tokens } = resolveAppearance({
      relayTemplate: "ember",
      theme: { accent: "#3366ff", "radius-card": "4px", bg: "#000000" }
    });
    expect(tokens.accent).toBe("#3366ff");
    expect(tokens["accent-soft"]).toBe("rgba(51, 102, 255, 0.14)");
    expect(tokens["on-accent"]).toBe(
      contrastRatio("#000000", "#3366ff") >= contrastRatio("#FFFFFF", "#3366ff") ? "#000000" : "#FFFFFF"
    );
    expect(tokens["radius-card"]).toBe("4px");
    expect(tokens.bg).toBe("#000000");
  });

  it("carries only brand overrides into a template the viewer picked", () => {
    const { tokens } = resolveAppearance({
      relayTemplate: "ember",
      viewerTemplate: "daylight",
      theme: { accent: "#1d4ed8", bg: "#000000", text: "#ffffff", "radius-card": "4px" }
    });
    expect(tokens.bg).toBe(template("daylight").tokens.bg);
    expect(tokens.text).toBe(template("daylight").tokens.text);
    expect(tokens.accent).toBe("#1d4ed8");
    expect(tokens["radius-card"]).toBe("4px");
  });

  it("lets the relay accentColor win over a theme accent, exactly as before in visor", () => {
    const { tokens } = resolveAppearance({ theme: { accent: "#3366ff" }, accentColor: "#7AA7FF" });
    const accent = accentTokens("#7AA7FF")!;
    expect([tokens.accent, tokens["accent-soft"], tokens["on-accent"]]).toEqual([
      accent.accent,
      accent.accentSoft,
      accent.onAccent
    ]);
  });

  it("keeps a brand accent legible in templates other than visor", () => {
    const { tokens } = resolveAppearance({ viewerTemplate: "daylight", accentColor: "#C6F432" });
    expect(tokenContrast(tokens, "accent", "surface-1")).toBeGreaterThanOrEqual(4.5);
    expect(tokenContrast(tokens, "on-accent", "accent")).toBeGreaterThanOrEqual(4.5);
    const beacon = resolveAppearance({ viewerTemplate: "beacon", accentColor: "#1E3A8A" }).tokens;
    expect(tokenContrast(beacon, "accent", "surface-1")).toBeGreaterThanOrEqual(4.5);
  });
});

describe("applying a template", () => {
  it("writes every token, the colour scheme and the browser chrome colour", () => {
    const properties = new Map<string, string>();
    const meta = { "theme-color": "#0B0C0E", "color-scheme": "dark" } as Record<string, string>;
    const root = {
      style: { setProperty: (name: string, value: string) => properties.set(name, value), colorScheme: "" },
      dataset: {} as Record<string, string>,
      ownerDocument: {
        querySelector: (selector: string) => {
          const name = /name="([^"]+)"/.exec(selector)?.[1] ?? "";
          return { setAttribute: (_: string, value: string) => (meta[name] = value) };
        }
      }
    };
    applyAppearance(resolveAppearance({ viewerTemplate: "daylight" }), root as unknown as HTMLElement);
    expect(properties.size).toBe(TEMPLATE_TOKENS.length);
    expect(properties.get("--bg")).toBe(template("daylight").tokens.bg);
    expect(root.style.colorScheme).toBe("light");
    expect(root.dataset).toEqual({ template: "daylight", scheme: "light" });
    expect(meta).toEqual({ "theme-color": template("daylight").tokens.bg, "color-scheme": "light" });
  });

  it("renders the picker as one native radio per template with the active one checked", () => {
    const html = renderToStaticMarkup(
      <LanguageProvider>
        <TemplatePicker value="ember" onSelect={() => {}} />
      </LanguageProvider>
    );
    expect(html.match(/type="radio"/g)).toHaveLength(TEMPLATES.length);
    expect(html).toMatch(/checked="" value="ember"/);
    expect(html.match(/checked=""/g)).toHaveLength(1);
    expect(html).toContain("<fieldset");
  });
});

describe("viewer template persistence", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubStorage() {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key)
      }
    });
  }

  it("survives the voice session rewriting its settings", () => {
    stubStorage();
    saveStoredAppearance({ template: "beacon" });
    saveStoredSettings({ voiceGender: "male" });
    expect(loadStoredSettings()).toMatchObject({ voiceGender: "male", template: "beacon" });
    saveStoredAppearance({ template: undefined });
    expect(loadStoredSettings()).not.toHaveProperty("template");
    expect(loadStoredSettings()).toMatchObject({ voiceGender: "male" });
  });

  it("drops a malformed stored template id", () => {
    expect(normalizeStoredSettings({ template: "Beacon; x" })).toEqual({});
    expect(normalizeStoredSettings({ template: "holo" })).toEqual({ template: "holo" });
  });
});

describe("device copy", () => {
  const en = createTranslator("en-US");
  const zh = createTranslator("zh-CN");
  const helmet = { device: "helmet" as const };

  it("keeps the generic device copy without a relay device label", () => {
    expect(deviceAssistantCopy(en, "en-US", "voice.assistantKind", helmet)).toBe("Helmet voice assistant");
  });

  it("prefers the relay's device label in both languages", () => {
    const bike = { ...helmet, deviceProfile: "bicycle-helmet", deviceLabel: "bicycle helmet" };
    expect(deviceAssistantCopy(en, "en-US", "voice.assistantKind", bike)).toBe("Bicycle helmet voice assistant");
    expect(deviceAssistantCopy(en, "en-US", "voice.assistantLabel", bike, { name: "Max" })).toBe(
      "Max, bicycle helmet voice assistant"
    );
    expect(deviceAssistantCopy(zh, "zh-CN", "voice.assistantKind", bike)).toBe("自行车头盔语音助手");
    const custom = { ...helmet, deviceProfile: "ski-goggles", deviceLabel: "滑雪镜" };
    expect(deviceAssistantCopy(en, "en-US", "voice.assistantKind", custom)).toBe("滑雪镜 voice assistant");
    expect(deviceAssistantCopy(zh, "zh-CN", "voice.assistantLabel", custom, { name: "Max" })).toBe(
      "Max 滑雪镜语音助手"
    );
  });
});
