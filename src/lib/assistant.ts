// The assistant's public identity as the web client uses it: name, the
// wearable it lives in, what the wearer says to address it, and its brand
// accent. The relay reports this on /health (AgentHealth.assistant); older
// relays do not, and then the client is the original "Max" helmet assistant.

import type { AssistantDevice, AssistantSummary } from "../../shared/agent";

export type AssistantIdentity = {
  name: string;
  device: AssistantDevice;
  wakePhrase: string;
  wakeWordEnabled: boolean;
  tagline?: string;
  developer?: string;
  /** Validated #RRGGBB, or undefined to keep the client's default accent. */
  accentColor?: string;
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
  return {
    name,
    device,
    wakePhrase: cleanText(summary.wakePhrase, 40) || name,
    wakeWordEnabled: summary.wakeWordEnabled !== false,
    ...(tagline ? { tagline } : {}),
    ...(developer ? { developer } : {}),
    ...(accentColor ? { accentColor: summary.accentColor!.trim().toUpperCase() } : {})
  };
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(r: number, g: number, b: number): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

const DARK_INK = "#0B0C0E";
const LIGHT_INK = "#FFFFFF";

/** The accent and the two values derived from it. `onAccent` is whichever of
 *  near-black or white reads with more contrast on the accent. */
export function accentTokens(hex: string): { accent: string; accentSoft: string; onAccent: string } | null {
  if (!HEX_COLOR.test(hex)) return null;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const lum = luminance(r, g, b);
  const darkInk = luminance(0x0b, 0x0c, 0x0e);
  const contrastWithDark = (lum + 0.05) / (darkInk + 0.05);
  const contrastWithWhite = 1.05 / (lum + 0.05);
  return {
    accent: hex.toUpperCase(),
    accentSoft: `rgba(${r}, ${g}, ${b}, 0.14)`,
    onAccent: contrastWithDark >= contrastWithWhite ? DARK_INK : LIGHT_INK
  };
}

const ACCENT_PROPERTIES = ["--accent", "--accent-soft", "--on-accent"] as const;

/** Apply (or, with no valid colour, remove) a runtime accent on an element —
 *  normally document.documentElement, where the stylesheet's defaults live. */
export function applyAccent(element: HTMLElement, hex: string | undefined) {
  const tokens = hex ? accentTokens(hex) : null;
  if (!tokens) {
    for (const property of ACCENT_PROPERTIES) element.style.removeProperty(property);
    return;
  }
  element.style.setProperty("--accent", tokens.accent);
  element.style.setProperty("--accent-soft", tokens.accentSoft);
  element.style.setProperty("--on-accent", tokens.onAccent);
}
