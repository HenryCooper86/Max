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
const ENCRYPTION_VERSION = "v1";

/** SHA-256 hex digest of a token, the only form tokens are stored in. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** A new opaque token: the prefix followed by 32 random bytes in base64url. */
export function newToken(prefix: "mcs_" | "mpk_"): string {
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

/** Encrypts a model key as `v1:<iv>:<tag>:<ciphertext>` (base64 parts). */
export function encryptModelKey(plain: string, key: Buffer, projectId: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(associatedData(projectId));
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENCRYPTION_VERSION, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":");
}

/** Decrypts a stored model key; undefined when it is malformed, tampered with or under another key. */
export function decryptModelKey(stored: string, key: Buffer, projectId: string): string | undefined {
  const parts = stored.split(":");
  if (parts.length !== 4 || parts[0] !== ENCRYPTION_VERSION) return undefined;
  const iv = Buffer.from(parts[1] ?? "", "base64");
  const tag = Buffer.from(parts[2] ?? "", "base64");
  const ciphertext = Buffer.from(parts[3] ?? "", "base64");
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
