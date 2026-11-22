// What Max Cloud reads from its surroundings: the clock, the environment and
// the configured payment providers. Each has a seam so tests can pin them.

import { randomBytes } from "node:crypto";
import { paymentProvider, paymentProviders, type PaymentProvider } from "./payments";

let clock: () => number = Date.now;
let providerOverride: PaymentProvider[] | undefined;

/** The current time in milliseconds. */
export function now(): number {
  return clock();
}

/** Test seam: pins the clock (omit to restore Date.now). */
export function setCloudClock(next?: () => number): void {
  clock = next ?? Date.now;
}

/** Test seam: replaces the configured payment providers (omit to restore the real ones). */
export function setCloudPaymentProviders(providers?: PaymentProvider[]): void {
  providerOverride = providers;
}

/** A configured payment provider by id. */
export function cloudPaymentProvider(id: string): PaymentProvider | undefined {
  if (!providerOverride) return paymentProvider(id);
  return providerOverride.find((provider) => provider.id === id && provider.configured());
}

/** Every configured payment provider. */
export function cloudPaymentProviders(): PaymentProvider[] {
  if (!providerOverride) return paymentProviders();
  return providerOverride.filter((provider) => provider.configured());
}

const HEX_KEY = /^[0-9a-fA-F]{64}$/;
const BASE64_KEY = /^(?:[A-Za-z0-9+/]+|[A-Za-z0-9_-]+)={0,2}$/;

function parseSecretKey(value: string | undefined): Buffer | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  // 64 hex characters are also valid base64 (48 bytes), so hex is tried first.
  if (HEX_KEY.test(raw)) return Buffer.from(raw, "hex");
  if (!BASE64_KEY.test(raw)) return undefined;
  const key = Buffer.from(raw, raw.includes("-") || raw.includes("_") ? "base64url" : "base64");
  return key.length === 32 ? key : undefined;
}

/** CLOUD_SECRET_KEY as 32 bytes, or undefined when it is unset or not exactly 32 bytes (hex or base64). */
export function cloudSecretKey(): Buffer | undefined {
  return parseSecretKey(process.env.CLOUD_SECRET_KEY);
}

/** CLOUD_SECRET_KEY_PREVIOUS, the key being rotated away from: read with, never written with. */
function cloudPreviousSecretKey(): Buffer | undefined {
  return parseSecretKey(process.env.CLOUD_SECRET_KEY_PREVIOUS);
}

/** True when CLOUD_SECRET_KEY_PREVIOUS is set but is not a 32-byte key, so it is ignored. */
export function cloudPreviousSecretKeyInvalid(): boolean {
  return Boolean(process.env.CLOUD_SECRET_KEY_PREVIOUS?.trim()) && !cloudPreviousSecretKey();
}

/** The keys stored secrets may decrypt with: the current key first, then the previous one. */
export function cloudSecretKeys(): Buffer[] {
  return [cloudSecretKey(), cloudPreviousSecretKey()].filter((key): key is Buffer => key !== undefined);
}

// Which relay process owns a live session's checkpoint row. A new id every
// start, so a restarted relay treats its predecessor's rows like any other
// dead instance's and never mistakes them for its own running sessions.
let instanceId = `ins_${randomBytes(8).toString("hex")}`;

export function cloudInstanceId(): string {
  return instanceId;
}

/** Test seam: pretends to be another relay process (omit for a fresh id, as after a restart). */
export function setCloudInstanceId(next?: string): void {
  instanceId = next ?? `ins_${randomBytes(8).toString("hex")}`;
}

/** CLOUD_PUBLIC_URL without a trailing slash, or undefined when unset or not an http(s) URL. */
export function cloudPublicUrl(): string | undefined {
  const raw = process.env.CLOUD_PUBLIC_URL?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (url.search || url.hash || url.username || url.password) return undefined;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return undefined;
  }
}

/** True only when CLOUD_SECRET_KEY decodes to exactly 32 bytes. */
export function cloudEnabled(): boolean {
  return cloudSecretKey() !== undefined;
}
