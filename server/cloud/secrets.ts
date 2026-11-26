// Max Cloud's cryptography: password hashing (scrypt, like server/accounts.ts),
// opaque bearer tokens stored only as SHA-256 hashes, and AES-256-GCM for the
// customers' model keys at rest.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback) as (password: string, salt: string, keylen: number) => Promise<Buffer>;

const SCRYPT_KEY_LENGTH = 64;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ENCRYPTION_VERSION = "v2";
/** Written before key ids existed; still read. */
const LEGACY_VERSION = "v1";

/** SHA-256 hex digest of a token, the only form tokens are stored in. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * A new opaque token (`mcs_` a console login, `mpk_` a project key, `mcr_` a
 * password-reset link): the prefix followed by 32 random bytes in base64url.
 */
export function newToken(prefix: "mcs_" | "mpk_" | "mcr_"): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

/** A random id with a readable prefix. */
export function newId(prefix: string): string {
  return `${prefix}${randomBytes(12).toString("hex")}`;
}

export function newPasswordSalt(): string {
  return randomBytes(16).toString("hex");
}

export async function hashPassword(password: string, salt: string): Promise<string> {
  return (await scrypt(password, salt, SCRYPT_KEY_LENGTH)).toString("hex");
}

/** Constant-time comparison of two hex password hashes. */
export function passwordHashesMatch(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "hex");
  const bufferB = Buffer.from(b, "hex");
  if (bufferA.length !== bufferB.length || bufferA.length === 0) return false;
  return timingSafeEqual(bufferA, bufferB);
}

// The project id is bound as associated data, so a ciphertext copied onto
// another project's row does not decrypt there.
function associatedData(projectId: string): Buffer {
  return Buffer.from(`max-cloud:model-key:${projectId}`, "utf8");
}

/**
 * A short public fingerprint of an encryption key, written into every new
 * ciphertext so the relay knows which key it needs, and an operator rotating
 * CLOUD_SECRET_KEY can tell which rows still use the old one. 32 bits of a
 * hash say nothing useful about a 256-bit random key.
 */
export function secretKeyId(key: Buffer): string {
  return createHash("sha256").update("max-cloud:key-id:").update(key).digest("hex").slice(0, 8);
}

/** Encrypts a model key as `v2:<key id>:<iv>:<tag>:<ciphertext>` (base64 parts). */
export function encryptModelKey(plain: string, key: Buffer, projectId: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(associatedData(projectId));
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENCRYPTION_VERSION,
    secretKeyId(key),
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64")
  ].join(":");
}

/** The key id a stored secret names; undefined for `v1` ciphertexts, which name none. */
export function storedSecretKeyId(stored: string): string | undefined {
  const parts = stored.split(":");
  return parts.length === 5 && parts[0] === ENCRYPTION_VERSION ? parts[1] : undefined;
}

function openWith(key: Buffer, parts: string[], projectId: string): string | undefined {
  const iv = Buffer.from(parts[0] ?? "", "base64");
  const tag = Buffer.from(parts[1] ?? "", "base64");
  const ciphertext = Buffer.from(parts[2] ?? "", "base64");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(associatedData(projectId));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}

/**
 * Decrypts a stored model key with whichever of `keys` it was written with
 * (the current key and, while rotating, the previous one). Reads `v2` and the
 * older `v1`, which names no key and so is tried with each. Undefined when it
 * is malformed, tampered with or under none of the keys.
 */
export function decryptModelKey(
  stored: string,
  keys: Buffer | readonly Buffer[],
  projectId: string
): string | undefined {
  const candidates = Buffer.isBuffer(keys) ? [keys] : keys;
  const parts = stored.split(":");
  if (parts.length === 4 && parts[0] === LEGACY_VERSION) {
    for (const key of candidates) {
      const plain = openWith(key, parts.slice(1), projectId);
      if (plain !== undefined) return plain;
    }
    return undefined;
  }
  if (parts.length !== 5 || parts[0] !== ENCRYPTION_VERSION) return undefined;
  const key = candidates.find((candidate) => secretKeyId(candidate) === parts[1]);
  return key ? openWith(key, parts.slice(2), projectId) : undefined;
}
