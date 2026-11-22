/**
 * Moves every Max Cloud project's stored secrets (model keys, webhook signing
 * secrets) onto the current CLOUD_SECRET_KEY, after a key rotation:
 *
 *   npm run cloud:reencrypt -- --check   # only report which key each secret uses
 *   npm run cloud:reencrypt              # re-encrypt them under CLOUD_SECRET_KEY
 *
 * Run it with the same environment as the relay (CLOUD_SECRET_KEY set to the
 * new key, CLOUD_SECRET_KEY_PREVIOUS to the old one, the same STUDIO_DIR) and
 * on the relay host, in the app directory. It is safe while the relay runs and
 * safe to run twice. The steps are in docs/cloud.md (Rotating CLOUD_SECRET_KEY).
 *
 * Exits 1 when a secret decrypts with neither key: those are listed, left as
 * they are, and their owners must enter them again.
 */
import { cloudPreviousSecretKeyInvalid, cloudSecretKey } from "../server/cloud/context";
import { checkStoredSecrets, reencryptStoredSecrets } from "../server/cloud/keyring";

const checkOnly = process.argv.slice(2).includes("--check");

if (!cloudSecretKey()) {
  console.error("Set CLOUD_SECRET_KEY to the new key (32 bytes, hex or base64) first.");
  process.exit(1);
}
if (cloudPreviousSecretKeyInvalid()) {
  console.error("CLOUD_SECRET_KEY_PREVIOUS is set but is not a 32-byte key (hex or base64).");
  process.exit(1);
}

const before = checkStoredSecrets();
console.log(
  `${before.total} stored secrets: ${before.current} under the current key, ${before.legacy} under the current key in the old format, ${before.previous} under CLOUD_SECRET_KEY_PREVIOUS, ${before.unreadable.length} unreadable.`
);

let unreadable = before.unreadable;
if (!checkOnly) {
  const outcome = reencryptStoredSecrets();
  console.log(
    `Re-encrypted ${outcome.reencrypted}.` +
      (outcome.skipped ? ` ${outcome.skipped} changed while this ran and already use the current key.` : "")
  );
  unreadable = outcome.unreadable;
  const after = checkStoredSecrets();
  if (after.total === after.current) {
    console.log("Every stored secret uses the current key: CLOUD_SECRET_KEY_PREVIOUS can be removed.");
  }
}

if (unreadable.length) {
  console.error("These decrypt with neither key; their owners must enter them again in the console:");
  for (const entry of unreadable) console.error(`  ${entry.projectId}  ${entry.secret}`);
  process.exit(1);
}
