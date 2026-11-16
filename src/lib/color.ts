// Colour arithmetic for the design tokens: parsing the two colour notations
// the token system accepts (hex and rgb()/rgba()), WCAG relative luminance and
// contrast, and the translucent "soft" tints derived from a solid colour.

export type Rgba = { r: number; g: number; b: number; a: number };

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const NUMBER = "\\s*(\\d{1,3}(?:\\.\\d+)?)\\s*";
const ALPHA = "\\s*(0|1|0?\\.\\d+|1\\.0+)\\s*";
const RGB = new RegExp(`^rgb\\(${NUMBER},${NUMBER},${NUMBER}\\)$`, "i");
const RGBA = new RegExp(`^rgba\\(${NUMBER},${NUMBER},${NUMBER},${ALPHA}\\)$`, "i");

/** Parse `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb(r, g, b)` or
 *  `rgba(r, g, b, a)`; anything else (names, hsl, var(), expressions) is null. */
export function parseColor(value: string): Rgba | null {
  const text = value.trim();
  const hex = HEX.exec(text)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex;
    const channel = (index: number) => parseInt(full.slice(index * 2, index * 2 + 2), 16);
    return { r: channel(0), g: channel(1), b: channel(2), a: full.length === 8 ? channel(3) / 255 : 1 };
  }
  const match = RGBA.exec(text) ?? RGB.exec(text);
  if (!match) return null;
  const r = Number(match[1]);
  const g = Number(match[2]);
  const b = Number(match[3]);
  if (r > 255 || g > 255 || b > 255) return null;
  return { r, g, b, a: match[4] === undefined ? 1 : Number(match[4]) };
}

function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of an opaque colour. */
function luminance({ r, g, b }: Rgba): number {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** A translucent colour flattened onto an opaque backdrop. */
function composite(top: Rgba, backdrop: Rgba): Rgba {
  const mix = (front: number, back: number) => front * top.a + back * (1 - top.a);
  return { r: mix(top.r, backdrop.r), g: mix(top.g, backdrop.g), b: mix(top.b, backdrop.b), a: 1 };
}

/** WCAG contrast ratio of `foreground` over `background` (translucent
 *  backgrounds are flattened onto `backdrop`, default black). */
export function contrastRatio(foreground: string, background: string, backdrop = "#000000"): number {
  const base = parseColor(backdrop);
  const back = parseColor(background);
  const front = parseColor(foreground);
  if (!base || !back || !front) return 0;
  const solidBack = composite(back, base);
  const solidFront = composite(front, solidBack);
  const lumFront = luminance(solidFront);
  const lumBack = luminance(solidBack);
  return (Math.max(lumFront, lumBack) + 0.05) / (Math.min(lumFront, lumBack) + 0.05);
}

/** `rgba()` of a solid colour at the given opacity. */
export function withAlpha(color: string, alpha: number): string {
  const rgb = parseColor(color);
  if (!rgb) return color;
  return `rgba(${Math.round(rgb.r)}, ${Math.round(rgb.g)}, ${Math.round(rgb.b)}, ${alpha})`;
}

/** Hex for an opaque colour. */
function toHex({ r, g, b }: Rgba): string {
  return `#${[r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

/** Whichever ink reads with more contrast on `fill`. Ties go to the dark ink. */
export function inkOn(fill: string, darkInk: string, lightInk: string): string {
  return contrastRatio(darkInk, fill) >= contrastRatio(lightInk, fill) ? darkInk : lightInk;
}

/** Move `color` toward `target` in small steps until it reaches `minimum`
 *  contrast on `background`, keeping as much of the original hue as it can.
 *  Returns the colour unchanged when it already passes. */
export function ensureContrast(color: string, background: string, target: string, minimum: number): string {
  const from = parseColor(color);
  const to = parseColor(target);
  if (!from || !to) return color;
  if (contrastRatio(color, background) >= minimum) return color;
  for (let step = 1; step <= 20; step += 1) {
    const t = step / 20;
    const mixed = toHex({
      r: from.r + (to.r - from.r) * t,
      g: from.g + (to.g - from.g) * t,
      b: from.b + (to.b - from.b) * t,
      a: 1
    });
    if (contrastRatio(mixed, background) >= minimum) return mixed;
  }
  return toHex(to);
}
