// The assistant's public identity as the web client uses it: name, the
// wearable it lives in, what the wearer says to address it, and its brand
// accent and look. The relay reports this on /health (AgentHealth.assistant); older
// relays do not, and then the client is the original "Max" helmet assistant.

import { characterList, type CharacterId } from "../../shared/characters";
import type { AssistantDevice, AssistantSummary, VoiceVisualizer } from "../../shared/agent";
import { inkOn, withAlpha } from "./color";
import { sanitizeThemeOverrides, type ThemeOverrides } from "./theme-tokens";
import { isVisualizer } from "./visualizer";

export type AssistantIdentity = {
  name: string;
  device: AssistantDevice;
  wakePhrase: string;
  wakeWordEnabled: boolean;
  tagline?: string;
  developer?: string;
  /** Validated #RRGGBB, or undefined to keep the client's default accent. */
  accentColor?: string;
  /** Specific device id (e.g. "bicycle-helmet") and its human name. */
  deviceProfile?: string;
  deviceLabel?: string;
  /** Design template the owner chose; may name a template this client lacks. */
  template?: string;
  /** Validated per-token overrides (see theme-tokens.ts). */
  theme?: ThemeOverrides;
  /** Present (false) only when the owner pinned the template. */
  templateSwitching?: false;
  /** The owner's square logo: a validated same-origin "/brand/…" path. */
  logoUrl?: string;
  /** The owner's voice display style, when it is one this client draws. */
  visualizer?: VoiceVisualizer;
  /** The creatures that fly on the pages, when the owner chose them. */
  characters?: CharacterId[];
};

export const DEFAULT_ASSISTANT: AssistantIdentity = {
  name: "Max",
  device: "helmet",
  wakePhrase: "Max",
  wakeWordEnabled: true
};

const DEVICES = new Set<AssistantDevice>(["helmet", "glasses", "other"]);
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/** Normalise a relay summary into a complete identity, field by field, so a
 *  partially filled summary from a newer or misconfigured relay still yields
 *  a usable name, device and wake phrase. */
export function resolveAssistant(summary: AssistantSummary | undefined | null): AssistantIdentity {
  if (!summary) return DEFAULT_ASSISTANT;
  const name = cleanText(summary.name, 40) || DEFAULT_ASSISTANT.name;
  const device = DEVICES.has(summary.device) ? summary.device : DEFAULT_ASSISTANT.device;
  const tagline = cleanText(summary.tagline, 120);
  const developer = cleanText(summary.developer, 80);
  const accentColor = typeof summary.accentColor === "string" && HEX_COLOR.test(summary.accentColor.trim());
  const deviceProfile = cleanText(summary.deviceProfile, 40);
  const deviceLabel = cleanText(summary.deviceLabel, 40);
  const template = cleanText(summary.template, 32).toLowerCase();
  const theme = sanitizeThemeOverrides(summary.theme);
  const logoUrl = brandLogoPath(summary.logoUrl);
  const visualizer = isVisualizer(summary.visualizer) ? summary.visualizer : undefined;
  const characters = characterList(summary.characters);
  return {
    name,
    device,
    wakePhrase: cleanText(summary.wakePhrase, 40) || name,
    wakeWordEnabled: summary.wakeWordEnabled !== false,
    ...(tagline ? { tagline } : {}),
    ...(developer ? { developer } : {}),
    ...(accentColor ? { accentColor: summary.accentColor!.trim().toUpperCase() } : {}),
    ...(deviceProfile ? { deviceProfile } : {}),
    ...(deviceLabel ? { deviceLabel } : {}),
    ...(template ? { template } : {}),
    ...(Object.keys(theme).length ? { theme } : {}),
    ...(summary.templateSwitching === false ? { templateSwitching: false as const } : {}),
    ...(logoUrl ? { logoUrl } : {}),
    ...(visualizer ? { visualizer } : {}),
    ...(characters ? { characters } : {})
  };
}

const BRAND_BASE = "https://relay.invalid";

/** The relay's logo path if it is a plain same-origin path under /brand/,
 *  else undefined. Absolute and protocol-relative URLs, backslashes, control
 *  characters, and paths that climb out of /brand/ are all refused; the
 *  result is the normalised path and query. */
export function brandLogoPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (!raw.startsWith("/brand/") || raw.startsWith("//") || raw.length > 512) return undefined;
  if (raw.includes("\\") || [...raw].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) {
    return undefined;
  }
  try {
    const url = new URL(raw, BRAND_BASE);
    if (url.origin !== BRAND_BASE || !url.pathname.startsWith("/brand/") || url.pathname === "/brand/")
      return undefined;
    return `${url.pathname}${url.search}`;
  } catch {
    return undefined;
  }
}

const ICON_SELECTOR = 'link[rel~="icon"]';

/** Point the page's favicon links at the owner's logo, or put the static
 *  ones from index.html back when there is no logo. The originals are kept
 *  on each link so a later restore is exact. */
export function applyBrandFavicon(doc: Document, logoUrl: string | undefined): void {
  for (const link of doc.querySelectorAll<HTMLLinkElement>(ICON_SELECTOR)) {
    if (link.dataset.staticHref === undefined) {
      link.dataset.staticHref = link.getAttribute("href") ?? "";
      link.dataset.staticType = link.getAttribute("type") ?? "";
      link.dataset.staticSizes = link.getAttribute("sizes") ?? "";
    }
    const restore = (name: string, saved: string | undefined) =>
      saved ? link.setAttribute(name, saved) : link.removeAttribute(name);
    if (logoUrl) {
      link.setAttribute("href", logoUrl);
      // SVG or PNG, decided by the relay: let the browser sniff it.
      link.removeAttribute("type");
      link.setAttribute("sizes", "any");
    } else {
      restore("href", link.dataset.staticHref);
      restore("type", link.dataset.staticType);
      restore("sizes", link.dataset.staticSizes);
    }
  }
}

const DARK_INK = "#0B0C0E";
const LIGHT_INK = "#FFFFFF";

/** The accent and the two values derived from it. `onAccent` is whichever of
 *  near-black or white reads with more contrast on the accent. */
export function accentTokens(hex: string): { accent: string; accentSoft: string; onAccent: string } | null {
  if (!HEX_COLOR.test(hex)) return null;
  const accent = hex.toUpperCase();
  return { accent, accentSoft: withAlpha(accent, 0.14), onAccent: inkOn(accent, DARK_INK, LIGHT_INK) };
}
