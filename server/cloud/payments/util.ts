// Shared helpers for the payment providers: exact fen/yuan conversion, China-time formatting, header lookup and
// RSA key loading. Nothing here logs; key material never leaves these functions except as KeyObjects.
import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";

/** Environment the providers read on every call (process.env by default; tests pass their own). */
export type Env = Record<string, string | undefined>;

/** The subset of fetch the providers use. Injected in tests. */
export type HttpRequest = (url: string, init: RequestInit) => Promise<Response>;

/** Every provider network call gives up after 10 s. */
export const REQUEST_TIMEOUT_MS = 10_000;

/** Fen (integer) to a yuan string with exactly two decimals: 1 → "0.01", 5000 → "50.00". */
export function fenToYuan(fen: number): string {
  if (!Number.isSafeInteger(fen) || fen < 0) throw new RangeError("Amount must be a non-negative whole number of fen");
  const text = String(fen).padStart(3, "0");
  return `${text.slice(0, -2)}.${text.slice(-2)}`;
}

/**
 * A yuan amount string ("50.00", "10.1", "20") to fen, with string math only (no floating point).
 * Returns null for anything that is not a plain non-negative decimal with at most two fraction digits.
 */
export function yuanToFen(yuan: string): number | null {
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(yuan.trim());
  if (!match) return null;
  const whole = Number.parseInt(match[1] ?? "0", 10);
  const fraction = Number.parseInt((match[2] ?? "").padEnd(2, "0"), 10);
  return whole * 100 + fraction;
}

const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;

function chinaParts(epochMs: number) {
  const date = new Date(epochMs + CHINA_OFFSET_MS);
  const two = (value: number) => String(value).padStart(2, "0");
  return {
    date: `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())}`,
    time: `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())}`
  };
}

/** RFC 3339 in China Standard Time, e.g. "2026-11-18T13:29:35+08:00" (WeChat Pay time_expire). */
export function chinaRfc3339(epochMs: number): string {
  const { date, time } = chinaParts(epochMs);
  return `${date}T${time}+08:00`;
}

/** "yyyy-MM-dd HH:mm:ss" in Asia/Shanghai (Alipay timestamp / time_expire). China has no DST. */
export function chinaDateTime(epochMs: number): string {
  const { date, time } = chinaParts(epochMs);
  return `${date} ${time}`;
}

/** A single header value, case-insensitively. Repeated headers are refused (undefined). */
export function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  let found: string | undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted || value === undefined) continue;
    if (Array.isArray(value) || found !== undefined) return undefined;
    found = value;
  }
  return found;
}

/** Trims and shortens text for error messages so provider answers never flood logs. */
export function brief(value: unknown, max = 200): string {
  const text = typeof value === "string" ? value : "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Resolves a key setting to its text: PEM text (literal "\n" escapes allowed), a bare base64 DER key (the format
 * Alipay's key tool exports), or a path to a file holding either.
 */
function keyText(setting: string): string {
  const value = setting.trim();
  if (value.includes("-----BEGIN")) return value.replace(/\\r/g, "").replace(/\\n/g, "\n");
  if (isBareBase64(value)) return value;
  const fromFile = readFileSync(value, "utf8").trim();
  if (fromFile.includes("-----BEGIN") || isBareBase64(fromFile)) return fromFile;
  throw new Error("Not a key");
}

function isBareBase64(value: string): boolean {
  // DER-encoded keys always start with a SEQUENCE header, which is "MI" in base64.
  return /^MI[A-Za-z0-9+/=\s]+$/.test(value);
}

function wrapPem(base64: string, label: string): string {
  const body = base64.replace(/\s+/g, "");
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

const privateKeys = new Map<string, KeyObject>();
const publicKeys = new Map<string, KeyObject>();

/** Parses an RSA private key setting (cached by setting). Throws when it is not an RSA private key. */
export function loadPrivateKey(setting: string): KeyObject {
  const cached = privateKeys.get(setting);
  if (cached) return cached;
  const text = keyText(setting);
  let key: KeyObject | undefined;
  if (text.includes("-----BEGIN")) {
    key = createPrivateKey(text);
  } else {
    for (const label of ["PRIVATE KEY", "RSA PRIVATE KEY"]) {
      try {
        key = createPrivateKey(wrapPem(text, label));
        break;
      } catch {
        // Try the next encoding.
      }
    }
  }
  if (!key || key.asymmetricKeyType !== "rsa") throw new Error("Not an RSA private key");
  privateKeys.set(setting, key);
  return key;
}

/** Parses an RSA public key setting (cached by setting). Throws when it is not an RSA public key. */
export function loadPublicKey(setting: string): KeyObject {
  const cached = publicKeys.get(setting);
  if (cached) return cached;
  const text = keyText(setting);
  let key: KeyObject | undefined;
  if (text.includes("-----BEGIN")) {
    if (text.includes("PRIVATE KEY-----")) throw new Error("Expected a public key");
    key = createPublicKey(text);
  } else {
    for (const label of ["PUBLIC KEY", "RSA PUBLIC KEY"]) {
      try {
        key = createPublicKey(wrapPem(text, label));
        break;
      } catch {
        // Try the next encoding.
      }
    }
  }
  if (!key || key.type !== "public" || key.asymmetricKeyType !== "rsa") throw new Error("Not an RSA public key");
  publicKeys.set(setting, key);
  return key;
}

/** True when the setting parses as the expected kind of RSA key. */
export function keyParses(setting: string | undefined, kind: "private" | "public"): boolean {
  if (!setting?.trim()) return false;
  try {
    if (kind === "private") loadPrivateKey(setting);
    else loadPublicKey(setting);
    return true;
  } catch {
    return false;
  }
}
