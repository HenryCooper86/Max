// Design templates: complete, named token sets for the Visor design system,
// one per kind of embodied device and light condition. A template is applied
// by writing its tokens onto <html> as CSS custom properties, so every rule in
// styles.css that reads a token follows it.
//
// Precedence, lowest first:
//   built-in default (visor) → relay assistant.template → the viewer's own
//   choice (unless the owner pinned the template) → relay assistant.theme
//   overrides → relay assistant.accentColor.

import { accentTokens } from "./assistant";
import { contrastRatio, ensureContrast, inkOn, withAlpha } from "./color";
import {
  TEMPLATE_TOKENS,
  type ColorToken,
  type OverridableToken,
  type ThemeOverrides,
  type TokenMap
} from "./theme-tokens";

type TemplateScheme = "dark" | "light";
type Bilingual = { zh: string; en: string };

export type DesignTemplate = {
  id: string;
  label: Bilingual;
  description: Bilingual;
  scheme: TemplateScheme;
  /** Four colours for the picker's thumbnail. */
  swatch: { bg: string; surface: string; text: string; accent: string };
  tokens: TokenMap;
};

/** The colours a template designs by hand; everything else is derived. */
type BaseColors = Record<
  | "bg"
  | "surface-1"
  | "surface-2"
  | "surface-3"
  | "text"
  | "text-2"
  | "text-3"
  | "accent"
  | "user"
  | "danger"
  | "warn"
  | "ok",
  string
>;

type TemplateSpec = Omit<DesignTemplate, "tokens" | "swatch"> & {
  colors: BaseColors;
  /** Explicit values for derived or non-colour tokens. */
  tokens?: Partial<TokenMap>;
  /** Opacity of the -soft tints (selected states, banners). */
  softAlpha?: number;
};

const SPACE_GROTESK =
  '"Space Grotesk", "PingFang SC", "HarmonyOS Sans SC", "Source Han Sans SC", "Noto Sans SC", system-ui, sans-serif';
const SPACE_MONO = '"Space Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
const CJK = '"PingFang SC", "HarmonyOS Sans SC", "Source Han Sans SC", "Noto Sans SC", "Microsoft YaHei", sans-serif';
const SYSTEM_UI =
  'system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "HarmonyOS Sans SC", "Noto Sans SC", sans-serif';

/** Shared geometry and type; templates replace what they redesign. */
const BASE_TOKENS = {
  "radius-control": "10px",
  "radius-card": "16px",
  "radius-sheet": "24px",
  "radius-pill": "999px",
  "fs-12": "0.75rem",
  "fs-13": "0.8125rem",
  "fs-15": "0.9375rem",
  "fs-17": "1.0625rem",
  "fs-22": "1.375rem",
  "fs-32": "2rem",
  "line-w": "1px",
  "focus-w": "2px",
  glow: "1",
  "disabled-opacity": "0.5",
  "font-display": SPACE_GROTESK,
  "font-mono": SPACE_MONO,
  "font-cjk": CJK
} satisfies Partial<TokenMap>;

const WHITE = "#FFFFFF";

/** Dark ink for fills: the template's own darkest colour. */
function darkInkOf(scheme: TemplateScheme, colors: Pick<BaseColors, "bg" | "text">): string {
  return scheme === "dark" ? colors.bg : colors.text;
}

function defaultSoftAlpha(scheme: TemplateScheme): number {
  return scheme === "dark" ? 0.14 : 0.12;
}

/** Complete a template: derive line colours for the scheme, the -soft tints,
 *  and the inks that sit on solid accent/danger/warn fills. */
function defineTemplate(spec: TemplateSpec): DesignTemplate {
  const { colors, scheme } = spec;
  const soft = spec.softAlpha ?? defaultSoftAlpha(scheme);
  const darkInk = darkInkOf(scheme, colors);
  const veil = scheme === "dark" ? "#FFFFFF" : colors.text;
  const derived: Record<Exclude<ColorToken, keyof BaseColors>, string> = scheme === "dark"
    ? {
        line: "rgba(255, 255, 255, 0.08)",
        "line-strong": "rgba(255, 255, 255, 0.14)",
        "line-hover": "rgba(255, 255, 255, 0.22)",
        frame: "rgba(0, 0, 0, 0)",
        "accent-soft": withAlpha(colors.accent, soft),
        "on-accent": inkOn(colors.accent, darkInk, WHITE),
        "user-soft": withAlpha(colors.user, soft),
        "danger-soft": withAlpha(colors.danger, soft),
        "on-danger": inkOn(colors.danger, darkInk, WHITE),
        "warn-soft": withAlpha(colors.warn, soft),
        "on-warn": inkOn(colors.warn, darkInk, WHITE),
        "ok-soft": withAlpha(colors.ok, soft),
        scrim: "rgba(0, 0, 0, 0.64)",
        "lens-stroke": withAlpha(veil, 0.05),
        "lens-tick": withAlpha(veil, 0.1),
        scrollbar: colors["surface-3"]
      }
    : {
        line: withAlpha(colors.text, 0.12),
        "line-strong": withAlpha(colors.text, 0.22),
        "line-hover": withAlpha(colors.text, 0.36),
        frame: "rgba(0, 0, 0, 0)",
        "accent-soft": withAlpha(colors.accent, soft),
        "on-accent": inkOn(colors.accent, darkInk, WHITE),
        "user-soft": withAlpha(colors.user, soft),
        "danger-soft": withAlpha(colors.danger, soft),
        "on-danger": inkOn(colors.danger, darkInk, WHITE),
        "warn-soft": withAlpha(colors.warn, soft),
        "on-warn": inkOn(colors.warn, darkInk, WHITE),
        "ok-soft": withAlpha(colors.ok, soft),
        scrim: withAlpha(colors.text, 0.32),
        "lens-stroke": withAlpha(colors.text, 0.08),
        "lens-tick": withAlpha(colors.text, 0.18),
        scrollbar: withAlpha(colors.text, 0.28)
      };
  const tokens = { ...BASE_TOKENS, ...colors, ...derived, ...spec.tokens } as TokenMap;
  return {
    id: spec.id,
    label: spec.label,
    description: spec.description,
    scheme,
    swatch: { bg: tokens.bg, surface: tokens["surface-2"], text: tokens.text, accent: tokens.accent },
    tokens
  };
}

/** The original look: a calm dark instrument with one lime signal colour.
 *  Its values mirror the :root defaults in styles.css exactly. */
const VISOR = defineTemplate({
  id: "visor",
  label: { zh: "护目镜", en: "Visor" },
  description: { zh: "默认深色界面，一种信号色", en: "The default dark look with one signal colour" },
  scheme: "dark",
  colors: {
    bg: "#0b0c0e",
    "surface-1": "#131518",
    "surface-2": "#1a1d21",
    "surface-3": "#23272c",
    text: "#f2f4f5",
    "text-2": "#a3abb3",
    "text-3": "#6b737c",
    accent: "#c6f432",
    user: "#ff7a45",
    danger: "#ff5a4d",
    warn: "#ffc53d",
    ok: "#3ddc97"
  }
});

/** Bright outdoor use behind sunglasses or on a bike: white surfaces, ink
 *  text, and a deep cobalt that keeps its saturation in direct sun (pale
 *  colours wash out first). Semantic colours are darkened so they read as
 *  text on white, and the glow is halved — on paper it only greys the page. */
const DAYLIGHT = defineTemplate({
  id: "daylight",
  label: { zh: "日光", en: "Daylight" },
  description: { zh: "浅色高亮，适合户外阳光和太阳镜", en: "Light and crisp for sunlight, sunglasses and cycling" },
  scheme: "light",
  colors: {
    bg: "#f4f5f3",
    "surface-1": "#ffffff",
    "surface-2": "#eceee9",
    "surface-3": "#dfe2dc",
    text: "#0d1014",
    "text-2": "#3d444d",
    "text-3": "#5a626c",
    accent: "#1336e8",
    user: "#a83808",
    danger: "#b5121a",
    warn: "#7d4a00",
    ok: "#08662f"
  },
  tokens: {
    "radius-control": "8px",
    "radius-card": "14px",
    "radius-sheet": "20px",
    "line-w": "1px",
    glow: "0.45"
  }
});

/** Low vision (assistive glasses): pure black, white text, one strong
 *  yellow, a larger type scale, 2px lines and a 3px focus ring. Every text
 *  tier is near-white — nothing relies on faint grey. The system UI face is
 *  used for its open, unambiguous letterforms. */
const BEACON = defineTemplate({
  id: "beacon",
  label: { zh: "灯塔", en: "Beacon" },
  description: { zh: "高对比、大字号，适合低视力辅助眼镜", en: "High contrast and large type for low-vision glasses" },
  scheme: "dark",
  softAlpha: 0.2,
  colors: {
    bg: "#000000",
    "surface-1": "#000000",
    "surface-2": "#0d0d0d",
    "surface-3": "#2e2e2e",
    text: "#ffffff",
    "text-2": "#f0f0f0",
    "text-3": "#d6d6d6",
    accent: "#ffe500",
    user: "#7fe3ff",
    danger: "#ff6e61",
    warn: "#ffab4a",
    ok: "#5df5a8"
  },
  tokens: {
    line: "#8a8a8a",
    "line-strong": "#d6d6d6",
    "line-hover": "#ffffff",
    frame: "#8a8a8a",
    scrim: "rgba(0, 0, 0, 0.86)",
    "lens-stroke": "#8a8a8a",
    "lens-tick": "#8a8a8a",
    scrollbar: "#bdbdbd",
    "radius-control": "8px",
    "radius-card": "12px",
    "radius-sheet": "16px",
    "fs-12": "0.9375rem",
    "fs-13": "1rem",
    "fs-15": "1.125rem",
    "fs-17": "1.3125rem",
    "fs-22": "1.625rem",
    "fs-32": "2.5rem",
    "line-w": "2px",
    "focus-w": "3px",
    glow: "0",
    // Disabled options stay readable; the "needs a key" note says why.
    "disabled-opacity": "0.72",
    "font-display": SYSTEM_UI
  }
});

/** Night riding without blue light: warm charcoal, amber accent, and every
 *  status colour pulled toward the warm end (the "ok" green leans yellow). */
const EMBER = defineTemplate({
  id: "ember",
  label: { zh: "余烬", en: "Ember" },
  description: { zh: "暖色深色，夜骑时减少蓝光", en: "Warm dark with an amber accent, low on blue light" },
  scheme: "dark",
  colors: {
    bg: "#14100d",
    "surface-1": "#1c1713",
    "surface-2": "#251e19",
    "surface-3": "#30271f",
    text: "#f7e9d7",
    "text-2": "#cbb59c",
    "text-3": "#9a846c",
    accent: "#ffa631",
    user: "#ff8f6b",
    danger: "#ff6a52",
    warn: "#ffd45a",
    ok: "#b8d65c"
  },
  tokens: {
    line: "rgba(255, 214, 170, 0.08)",
    "line-strong": "rgba(255, 214, 170, 0.15)",
    "line-hover": "rgba(255, 214, 170, 0.24)",
    "lens-stroke": "rgba(255, 214, 170, 0.06)",
    "lens-tick": "rgba(255, 214, 170, 0.12)",
    "radius-control": "12px",
    "radius-card": "18px",
    "radius-sheet": "26px",
    glow: "0.8"
  }
});

/** AR/VR headsets: deep blue-black space, a cyan signal with a violet for
 *  the wearer's own voice, cool-tinted lines and rounder corners that sit
 *  comfortably in a curved field of view. */
const HOLO = defineTemplate({
  id: "holo",
  label: { zh: "全息", en: "Holo" },
  description: { zh: "冷色深空，适合 AR 与 VR 头显", en: "Cool deep-space dark for AR and VR headsets" },
  scheme: "dark",
  softAlpha: 0.16,
  colors: {
    bg: "#060914",
    "surface-1": "#0c1122",
    "surface-2": "#121a30",
    "surface-3": "#1b2541",
    text: "#eaf2ff",
    "text-2": "#a4b4d3",
    "text-3": "#7282a6",
    accent: "#4ae3ff",
    user: "#b995ff",
    danger: "#ff5f7e",
    warn: "#ffc95a",
    ok: "#4ff0b6"
  },
  tokens: {
    line: "rgba(150, 190, 255, 0.1)",
    "line-strong": "rgba(150, 190, 255, 0.18)",
    "line-hover": "rgba(150, 190, 255, 0.3)",
    "lens-stroke": "rgba(150, 190, 255, 0.12)",
    "lens-tick": "rgba(150, 190, 255, 0.16)",
    "radius-control": "14px",
    "radius-card": "22px",
    "radius-sheet": "30px"
  }
});

export const DEFAULT_TEMPLATE_ID = "visor";
export const TEMPLATES: readonly DesignTemplate[] = [VISOR, DAYLIGHT, BEACON, EMBER, HOLO];

export function findTemplate(id: string | undefined | null): DesignTemplate | undefined {
  return id ? TEMPLATES.find((template) => template.id === id) : undefined;
}

/** Tokens an owner's override carries into a template the viewer chose
 *  themselves. Surface and text colours were tuned for the owner's template
 *  and would break the viewer's contrast; brand colour and shape travel. */
const PORTABLE_OVERRIDES = new Set<OverridableToken>([
  "accent",
  "on-accent",
  "accent-soft",
  "radius-control",
  "radius-card",
  "radius-sheet",
  "radius-pill"
]);

/** A solid colour and the tokens that are computed from it. */
const DEPENDENTS: ReadonlyArray<[ColorToken, ColorToken | null, ColorToken]> = [
  ["accent", "on-accent", "accent-soft"],
  ["user", null, "user-soft"],
  ["danger", "on-danger", "danger-soft"],
  ["warn", "on-warn", "warn-soft"],
  ["ok", null, "ok-soft"]
];

function softAlphaOf(template: DesignTemplate): number {
  // Read back from the template's own accent tint so overrides match it.
  const match = /,\s*([\d.]+)\)$/.exec(template.tokens["accent-soft"]);
  return match ? Number(match[1]) : defaultSoftAlpha(template.scheme);
}

function applyOverrides(template: DesignTemplate, tokens: TokenMap, overrides: ThemeOverrides): void {
  const darkInk = darkInkOf(template.scheme, tokens);
  const soft = softAlphaOf(template);
  for (const [name, value] of Object.entries(overrides) as [OverridableToken, string][]) tokens[name] = value;
  for (const [base, ink, tint] of DEPENDENTS) {
    if (!(base in overrides)) continue;
    if (ink && !(ink in overrides)) tokens[ink] = inkOn(tokens[base], darkInk, WHITE);
    if (!(tint in overrides)) tokens[tint] = withAlpha(tokens[base], soft);
  }
}

export type AppearanceInput = {
  relayTemplate?: string;
  viewerTemplate?: string;
  /** False when the owner pinned the template. */
  templateSwitching?: boolean;
  theme?: ThemeOverrides;
  /** Validated #RRGGBB from AssistantSummary.accentColor. */
  accentColor?: string;
};

export type Appearance = {
  template: DesignTemplate;
  /** Where the template came from. */
  source: "default" | "relay" | "viewer";
  tokens: TokenMap;
};

/** Resolve the effective template and its final token values. */
export function resolveAppearance(input: AppearanceInput): Appearance {
  const relay = findTemplate(input.relayTemplate);
  const owner = relay ?? findTemplate(DEFAULT_TEMPLATE_ID)!;
  const viewer = input.templateSwitching !== false ? findTemplate(input.viewerTemplate) : undefined;
  const template = viewer ?? owner;
  const source = viewer ? "viewer" : relay ? "relay" : "default";
  const tokens = { ...template.tokens };

  const overrides = input.theme ?? {};
  const scoped =
    template.id === owner.id
      ? overrides
      : Object.fromEntries(
          Object.entries(overrides).filter(([name]) => PORTABLE_OVERRIDES.has(name as OverridableToken))
        );
  applyOverrides(template, tokens, scoped);

  const accent = input.accentColor ? accentTokens(input.accentColor) : null;
  if (accent) {
    // The Visor keeps today's behaviour exactly. Every other template holds
    // its contrast floor: the accent doubles as text on surface-1 (selected
    // segments, live values), so a brand colour that would fail there is
    // nudged toward the template's text colour, keeping its hue.
    const legible =
      template.id === DEFAULT_TEMPLATE_ID
        ? accent.accent
        : ensureContrast(accent.accent, tokens["surface-1"], tokens.text, 4.5);
    tokens.accent = legible;
    tokens["on-accent"] =
      template.id === DEFAULT_TEMPLATE_ID ? accent.onAccent : inkOn(legible, darkInkOf(template.scheme, tokens), WHITE);
    tokens["accent-soft"] =
      template.id === DEFAULT_TEMPLATE_ID ? accent.accentSoft : withAlpha(legible, softAlphaOf(template));
  }
  return { template, source, tokens };
}

/** Write an appearance onto the document: every token as a custom property
 *  on <html>, the colour scheme (form controls, scrollbars) and the browser
 *  chrome colour. */
export function applyAppearance(appearance: Appearance, root: HTMLElement = document.documentElement): void {
  for (const name of TEMPLATE_TOKENS) root.style.setProperty(`--${name}`, appearance.tokens[name]);
  root.style.colorScheme = appearance.template.scheme;
  root.dataset.template = appearance.template.id;
  root.dataset.scheme = appearance.template.scheme;
  const doc = root.ownerDocument;
  doc?.querySelector('meta[name="theme-color"]')?.setAttribute("content", appearance.tokens.bg);
  doc?.querySelector('meta[name="color-scheme"]')?.setAttribute("content", appearance.template.scheme);
}

/** Contrast of a text token over a surface token, for tests and audits. */
export function tokenContrast(tokens: TokenMap, text: ColorToken, surface: ColorToken): number {
  return contrastRatio(tokens[text], tokens[surface], tokens.bg);
}
