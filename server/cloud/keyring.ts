// CLOUD_SECRET_KEY rotation: which stored secrets each configured key can
// read, moving them all onto the current key, and telling the operator loudly
// when the relay was started with a key that reads none of them. Without that
// last part a changed key only shows up as every customer being told to "add
// a model key".

import { createLogger } from "../logger";
import { cloudPreviousSecretKeyInvalid, cloudSecretKey, cloudSecretKeys, now } from "./context";
import { webhookSecretScope } from "./customers";
import { decryptModelKey, encryptModelKey, secretKeyId, storedSecretKeyId } from "./secrets";
import { projectSecrets, replaceProjectSecret, type EncryptedSecretColumn } from "./store";

const log = createLogger("cloud");

const RECHECK_MS = 60_000;

const SECRETS: ReadonlyArray<{ column: EncryptedSecretColumn; name: "model key" | "webhook secret" }> = [
  { column: "model_key_enc", name: "model key" },
  { column: "webhook_secret_enc", name: "webhook secret" }
];

function scopeOf(column: EncryptedSecretColumn, projectId: string): string {
  return column === "model_key_enc" ? projectId : webhookSecretScope(projectId);
}

type Unreadable = { projectId: string; secret: "model key" | "webhook secret" };

export type StoredSecretsReport = {
  total: number;
  /** Written with the current key (and naming it). */
  current: number;
  /** Readable only with CLOUD_SECRET_KEY_PREVIOUS: run the re-encrypt. */
  previous: number;
  /** Readable with the current key, but in the v1 format that names no key. */
  legacy: number;
  /** Readable with no configured key. */
  unreadable: Unreadable[];
};

/** Tries every live project's stored secrets against the configured keys. */
export function checkStoredSecrets(): StoredSecretsReport {
  const report: StoredSecretsReport = { total: 0, current: 0, previous: 0, legacy: 0, unreadable: [] };
  const current = cloudSecretKey();
  if (!current) return report;
  const keys = cloudSecretKeys();
  for (const row of projectSecrets()) {
    for (const { column, name } of SECRETS) {
      const stored = row[column];
      if (!stored) continue;
      report.total += 1;
      const scope = scopeOf(column, row.id);
      if (decryptModelKey(stored, current, scope) !== undefined) {
        if (storedSecretKeyId(stored) === secretKeyId(current)) report.current += 1;
        else report.legacy += 1;
      } else if (decryptModelKey(stored, keys, scope) !== undefined) {
        report.previous += 1;
      } else {
        report.unreadable.push({ projectId: row.id, secret: name });
      }
    }
  }
  return report;
}

/**
 * Re-encrypts every live project's secrets that are not already under the
 * current key in the current format. Each row is replaced only if it still
 * holds what was read, so a key a customer saves meanwhile (already under the
 * current key) is never undone. Unreadable secrets are left as they are.
 * `beforeWrite` is a test seam.
 */
export function reencryptStoredSecrets(options: { beforeWrite?: () => void } = {}): {
  reencrypted: number;
  skipped: number;
  unreadable: Unreadable[];
} {
  const outcome = { reencrypted: 0, skipped: 0, unreadable: [] as Unreadable[] };
  const current = cloudSecretKey();
  if (!current) throw new Error("CLOUD_SECRET_KEY is not set to a 32-byte key");
  const currentId = secretKeyId(current);
  const keys = cloudSecretKeys();
  for (const row of projectSecrets()) {
    for (const { column, name } of SECRETS) {
      const stored = row[column];
      if (!stored || storedSecretKeyId(stored) === currentId) continue;
      const scope = scopeOf(column, row.id);
      const plain = decryptModelKey(stored, keys, scope);
      if (plain === undefined) {
        outcome.unreadable.push({ projectId: row.id, secret: name });
        continue;
      }
      options.beforeWrite?.();
      if (replaceProjectSecret(row.id, column, stored, encryptModelKey(plain, current, scope))) {
        outcome.reencrypted += 1;
      } else {
        outcome.skipped += 1;
      }
    }
  }
  return outcome;
}

let cached: { at: number; fingerprint: string; issues: string[]; unreadable: number } | undefined;

/** Test seam: forgets the cached check, as after a restart with other keys. */
export function resetCloudKeyCheck(): void {
  cached = undefined;
}

function keysFingerprint(): string {
  return `${cloudSecretKeys().map(secretKeyId).join(",")}|${process.env.CLOUD_SECRET_KEY_PREVIOUS ?? ""}`;
}

/**
 * Problems with CLOUD_SECRET_KEY for the readiness probe. Only a key that
 * reads none of the stored secrets, across more than one project, fails it:
 * that relay cannot serve any customer and should not take traffic (a deploy
 * with the wrong key stops there). Unreadable rows among readable ones, or in
 * a single project (one customer's secret saved under a key since lost says
 * nothing about the key configured now), are logged but do not take the whole
 * relay out of service. Checked at most once a minute.
 */
export function cloudReadinessIssues(): string[] {
  if (!cloudSecretKey()) return [];
  const fingerprint = keysFingerprint();
  const at = now();
  if (cached && cached.fingerprint === fingerprint && at - cached.at < RECHECK_MS) return cached.issues;
  const issues: string[] = [];
  if (cloudPreviousSecretKeyInvalid()) {
    issues.push("cloud-secret-key-previous-invalid");
    log.error("CLOUD_SECRET_KEY_PREVIOUS is set but is not 32 bytes in hex or base64, so it is ignored");
  }
  let report: StoredSecretsReport;
  try {
    report = checkStoredSecrets();
  } catch (error) {
    log.warn("stored secrets could not be checked", {
      message: error instanceof Error ? error.message : String(error)
    });
    cached = { at, fingerprint, issues, unreadable: cached?.unreadable ?? 0 };
    return issues;
  }
  const changed = !cached || cached.fingerprint !== fingerprint;
  const unreadableProjects = new Set(report.unreadable.map((entry) => entry.projectId));
  if (report.unreadable.length === report.total && unreadableProjects.size > 1) {
    issues.push("cloud-secret-key-mismatch");
    log.error(
      "CLOUD_SECRET_KEY reads none of the stored customer secrets: it is not the key they were encrypted with. Every Max Cloud session will fail. Put the old key back, or set it as CLOUD_SECRET_KEY_PREVIOUS (docs/cloud.md, Rotating CLOUD_SECRET_KEY)",
      { secrets: report.total }
    );
  } else if (report.unreadable.length && changed) {
    log.error("some stored customer secrets decrypt with no configured key; those projects cannot run", {
      unreadable: report.unreadable.length,
      projects: [...unreadableProjects].slice(0, 20)
    });
  }
  if (report.previous && changed) {
    log.warn("stored secrets still use CLOUD_SECRET_KEY_PREVIOUS: run npm run cloud:reencrypt", {
      secrets: report.previous
    });
  }
  cached = { at, fingerprint, issues, unreadable: report.unreadable.length };
  return issues;
}

/**
 * Stored secrets no configured key can read, as of the last readiness check.
 * Shown on /ready as a warning and on /metrics, so a wrong key on a relay with
 * a single project (which does not fail readiness) is still visible.
 */
export function cloudUnreadableSecrets(): number {
  cloudReadinessIssues();
  return cached?.unreadable ?? 0;
}

/** Warnings for /ready: things an operator should look at that do not stop the relay from serving. */
export function cloudReadinessWarnings(): string[] {
  return cloudUnreadableSecrets() > 0 && !cached?.issues.includes("cloud-secret-key-mismatch")
    ? ["cloud-secrets-unreadable"]
    : [];
}
