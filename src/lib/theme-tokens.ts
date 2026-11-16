// The design-token vocabulary shared by the templates (src/lib/templates.ts)
// and the relay's per-token overrides (AssistantSummary.theme). Every name is
// a CSS custom property on :root without its leading dashes. The relay value
// is owner-supplied text headed for an inline style, so it passes through an
// allow-list of names and a per-kind value pattern before it gets anywhere
// near the DOM.

import { parseColor } from "./color";

/** Colours. The -soft tints, on-* inks and line colours are derived per
 *  template (see templates.ts) but may be set explicitly. */
export const COLOR_TOKENS = [
  "bg",
  "surface-1",
  "surface-2",
  "surface-3",
  "line",
  "line-strong",
  "line-hover",
  "frame",
  "text",
  "text-2",
  "text-3",
  "accent",
  "on-accent",
  "accent-soft",
  "user",
  "user-soft",
  "danger",
  "danger-soft",
  "on-danger",
  "warn",
  "warn-soft",
  "on-warn",
  "ok",
  "ok-soft",
  "scrim",
  "lens-stroke",
  "lens-tick",
  "scrollbar"
] as const;

/** Lengths: corner radii, the type scale, and stroke widths. */
const LENGTH_TOKENS = [
  "radius-control",
  "radius-card",
  "radius-sheet",
  "radius-pill",
  "fs-12",
  "fs-13",
  "fs-15",
  "fs-17",
  "fs-22",
  "fs-32",
  "line-w",
  "focus-w"
] as const;

/** Unitless numbers, 0…1. `glow` scales the Visor's accent vignette (0 =
 *  none); `disabled-opacity` is how far disabled controls fade. */
const NUMBER_TOKENS = ["glow", "disabled-opacity"] as const;

/** Font stacks. Templates set them; relay overrides cannot (a font-family is
 *  free text, which the override validator never writes into a style). */
const FONT_TOKENS = ["font-display", "font-mono", "font-cjk"] as const;

export type ColorToken = (typeof COLOR_TOKENS)[number];
type LengthToken = (typeof LENGTH_TOKENS)[number];
type NumberToken = (typeof NUMBER_TOKENS)[number];
type FontToken = (typeof FONT_TOKENS)[number];
export type OverridableToken = ColorToken | LengthToken | NumberToken;
export type TemplateToken = OverridableToken | FontToken;
export type TokenMap = Record<TemplateToken, string>;
export type ThemeOverrides = Partial<Record<OverridableToken, string>>;

/** Every token a template must define. */
export const TEMPLATE_TOKENS: readonly TemplateToken[] = [
  ...COLOR_TOKENS,
  ...LENGTH_TOKENS,
  ...NUMBER_TOKENS,
  ...FONT_TOKENS
];

const COLOR_SET = new Set<string>(COLOR_TOKENS);
const LENGTH_SET = new Set<string>(LENGTH_TOKENS);
const NUMBER_SET = new Set<string>(NUMBER_TOKENS);

const PLAIN_NUMBER = /^\d{1,4}(?:\.\d{1,3})?$/;
const LENGTH = /^(\d{1,4}(?:\.\d{1,3})?)(px|rem)$/;

/** Upper bounds in px (rem × 16) — enough for any sane design, small enough
 *  that an override cannot blow a control off the screen. */
function lengthLimit(token: LengthToken): number {
  if (token === "radius-pill") return 9999;
  if (token.startsWith("radius-")) return 64;
  if (token.startsWith("fs-")) return 72;
  return 8;
}

function sanitizeLength(token: LengthToken, value: string): string | null {
  const plain = PLAIN_NUMBER.test(value) ? Number(value) : null;
  const match = LENGTH.exec(value);
  const px = plain ?? (match ? Number(match[1]) * (match[2] === "rem" ? 16 : 1) : null);
  if (px === null || !Number.isFinite(px) || px > lengthLimit(token)) return null;
  // A font size or stroke of zero is never intended; a zero radius is.
  if (px === 0 && !token.startsWith("radius-")) return null;
  return plain !== null ? `${plain}px` : value;
}

function sanitizeValue(token: OverridableToken, raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (!value || value.length > 48) return null;
  if (COLOR_SET.has(token)) return parseColor(value) ? value : null;
  if (LENGTH_SET.has(token)) return sanitizeLength(token as LengthToken, value);
  if (NUMBER_SET.has(token)) {
    if (!PLAIN_NUMBER.test(value)) return null;
    const number = Number(value);
    return number <= 1 ? String(number) : null;
  }
  return null;
}

function isOverridable(name: string): name is OverridableToken {
  return COLOR_SET.has(name) || LENGTH_SET.has(name) || NUMBER_SET.has(name);
}

/** Keep only allow-listed token names whose values match the safe pattern
 *  for that token's kind: hex or rgb()/rgba() colours, px/rem lengths (or a
 *  plain number, read as px), and plain numbers. Everything else is dropped. */
export function sanitizeThemeOverrides(theme: unknown): ThemeOverrides {
  if (!theme || typeof theme !== "object" || Array.isArray(theme)) return {};
  const clean: ThemeOverrides = {};
  for (const [name, raw] of Object.entries(theme as Record<string, unknown>)) {
    if (!isOverridable(name) || typeof raw !== "string") continue;
    const value = sanitizeValue(name, raw);
    if (value !== null) clean[name] = value;
  }
  return clean;
}
