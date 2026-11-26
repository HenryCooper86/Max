// Rotating CLOUD_SECRET_KEY: new ciphertexts name their key, the previous key
// still decrypts during a rotation, a re-encrypt moves every secret to the new
// key, and a relay started with the wrong key says so instead of quietly
// telling every customer to add a model key.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloudReadinessIssues, cloudReadinessWarnings, cloudUnreadableSecrets, projectRuntime } from "../server/cloud";
import { setCloudClock } from "../server/cloud/context";
import { createProject, patchProject, revealWebhookSecret, signup } from "../server/cloud/customers";
import { checkStoredSecrets, reencryptStoredSecrets, resetCloudKeyCheck } from "../server/cloud/keyring";
import { decryptModelKey, encryptModelKey, secretKeyId } from "../server/cloud/secrets";
import { immediate, liveProject, resetCloudDatabase, updateProject } from "../server/cloud/store";

const OLD = randomBytes(32);
const NEW = randomBytes(32);
const START = Date.UTC(2026, 10, 18, 12, 0, 0);
let clock = START;
const saved = {
  key: process.env.CLOUD_SECRET_KEY,
  previous: process.env.CLOUD_SECRET_KEY_PREVIOUS,
  signup: process.env.CLOUD_SIGNUP
};

function useKeys(current: Buffer, previous?: Buffer | string): void {
  process.env.CLOUD_SECRET_KEY = current.toString("base64");
  if (previous === undefined) delete process.env.CLOUD_SECRET_KEY_PREVIOUS;
  else process.env.CLOUD_SECRET_KEY_PREVIOUS = typeof previous === "string" ? previous : previous.toString("hex");
  resetCloudKeyCheck();
}

beforeEach(() => {
  process.env.CLOUD_SIGNUP = "open";
  useKeys(OLD);
  resetCloudDatabase(":memory:");
  clock = START;
  setCloudClock(() => clock);
});

afterEach(() => {
  resetCloudDatabase();
  setCloudClock();
  for (const [name, value] of [
    ["CLOUD_SECRET_KEY", saved.key],
    ["CLOUD_SECRET_KEY_PREVIOUS", saved.previous],
    ["CLOUD_SIGNUP", saved.signup]
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetCloudKeyCheck();
});

async function projectWithSecrets() {
  const account = await signup(`c${randomBytes(4).toString("hex")}@example.com`, "correct horse battery");
  if (!account.ok) throw new Error(account.error);
  const customerId = account.value.customer.id;
  const created = createProject(customerId, { name: "Shop" });
  if (!created.ok) throw new Error(created.error);
  const projectId = created.value.project.id;
  const tool = { name: "lookup", description: "Look it up", url: "https://tools.example.com/lookup", parameters: [] };
  const patched = patchProject(customerId, projectId, {
    modelKey: "sk-live-secret",
    studio: { ...created.value.project.studio, tools: [tool] }
  });
  if (!patched.ok) throw new Error(patched.error);
  const secret = revealWebhookSecret(customerId, projectId);
  if (!secret.ok) throw new Error(secret.error);
  return { customerId, projectId, webhookSecret: secret.value.secret };
}

describe("ciphertexts", () => {
  it("name the key they were written with, and still read the older v1 format", () => {
    const stored = encryptModelKey("sk-live-secret", NEW, "prj_a");
    expect(stored.split(":")).toHaveLength(5);
    expect(stored.startsWith(`v2:${secretKeyId(NEW)}:`)).toBe(true);
    expect(secretKeyId(NEW)).not.toBe(secretKeyId(OLD));
    expect(decryptModelKey(stored, [OLD, NEW], "prj_a")).toBe("sk-live-secret");
    expect(decryptModelKey(stored, [OLD], "prj_a")).toBeUndefined();

    // A v1 value, as releases before key ids wrote it: iv, tag and ciphertext without a key id.
    const [, , iv, tag, body] = encryptModelKey("sk-old", OLD, "prj_a").split(":");
    const legacy = ["v1", iv, tag, body].join(":");
    expect(decryptModelKey(legacy, OLD, "prj_a")).toBe("sk-old");
    expect(decryptModelKey(legacy, [NEW, OLD], "prj_a")).toBe("sk-old");
    expect(decryptModelKey(legacy, [NEW], "prj_a")).toBeUndefined();
  });
});

describe("rotating CLOUD_SECRET_KEY", () => {
  it("keeps every saved secret working through CLOUD_SECRET_KEY_PREVIOUS, then re-encrypts them under the new key", async () => {
    const { customerId, projectId, webhookSecret } = await projectWithSecrets();
    expect(checkStoredSecrets()).toMatchObject({ total: 2, current: 2, previous: 0, unreadable: [] });

    useKeys(NEW, OLD);
    expect(projectRuntime(projectId)).toMatchObject({ modelKey: "sk-live-secret", webhookSecret });
    expect(checkStoredSecrets()).toMatchObject({ total: 2, current: 0, previous: 2, unreadable: [] });
    expect(cloudReadinessIssues()).toEqual([]);

    expect(reencryptStoredSecrets()).toMatchObject({ reencrypted: 2, unreadable: [] });
    expect(liveProject(projectId)?.model_key_enc?.startsWith(`v2:${secretKeyId(NEW)}:`)).toBe(true);
    expect(reencryptStoredSecrets()).toMatchObject({ reencrypted: 0, unreadable: [] });

    // The old key can go now.
    useKeys(NEW);
    expect(checkStoredSecrets()).toMatchObject({ total: 2, current: 2, previous: 0, unreadable: [] });
    expect(projectRuntime(projectId)).toMatchObject({ modelKey: "sk-live-secret", webhookSecret });
    expect(revealWebhookSecret(customerId, projectId)).toMatchObject({ ok: true, value: { secret: webhookSecret } });
  });

  it("moves v1 secrets onto the current key too", async () => {
    const { projectId } = await projectWithSecrets();
    const [, , iv, tag, body] = encryptModelKey("sk-old", OLD, projectId).split(":");
    const row = liveProject(projectId)!;
    updateProject(projectId, row.customer_id, { model_key_enc: ["v1", iv, tag, body].join(":") });
    expect(checkStoredSecrets()).toMatchObject({ current: 1, legacy: 1 });
    expect(reencryptStoredSecrets()).toMatchObject({ reencrypted: 1 });
    expect(checkStoredSecrets()).toMatchObject({ current: 2, legacy: 0 });
    expect(projectRuntime(projectId)?.modelKey).toBe("sk-old");
  });

  it("never undoes a key the customer saved while the re-encrypt ran", async () => {
    const { customerId, projectId } = await projectWithSecrets();
    useKeys(NEW, OLD);
    const report = reencryptStoredSecrets({
      beforeWrite: () => {
        patchProject(customerId, projectId, { modelKey: "sk-saved-meanwhile" });
      }
    });
    expect(report.skipped).toBeGreaterThan(0);
    expect(projectRuntime(projectId)?.modelKey).toBe("sk-saved-meanwhile");
  });

  it("reports a relay started with the wrong key on /ready, and names the rows it cannot read", async () => {
    const { projectId } = await projectWithSecrets();
    const other = await projectWithSecrets();
    useKeys(NEW);
    const report = checkStoredSecrets();
    expect(report).toMatchObject({ total: 4, current: 0, previous: 0 });
    expect(report.unreadable).toEqual(
      expect.arrayContaining([
        { projectId, secret: "model key" },
        { projectId, secret: "webhook secret" },
        { projectId: other.projectId, secret: "model key" }
      ])
    );
    expect(cloudReadinessIssues()).toEqual(["cloud-secret-key-mismatch"]);
    expect(projectRuntime(projectId)).toBeUndefined();

    // Putting the old key back as the previous one is the fix.
    useKeys(NEW, OLD);
    expect(cloudReadinessIssues()).toEqual([]);
  });

  it("does not take the relay out of service when its only project's secrets are unreadable", async () => {
    // One customer's secrets saved under a key since lost say nothing about the key configured now.
    const { projectId } = await projectWithSecrets();
    useKeys(NEW);
    expect(checkStoredSecrets().unreadable).toHaveLength(2);
    expect(cloudReadinessIssues()).toEqual([]);
    expect(projectRuntime(projectId)).toBeUndefined();
    // But it is not silent: /ready carries a warning and /metrics a count.
    expect(cloudReadinessWarnings()).toEqual(["cloud-secrets-unreadable"]);
    expect(cloudUnreadableSecrets()).toBe(2);
    useKeys(NEW, OLD);
    expect(cloudReadinessWarnings()).toEqual([]);
    expect(cloudUnreadableSecrets()).toBe(0);
  });

  it("does not take the relay out of service for one unreadable row among readable ones", async () => {
    const first = await projectWithSecrets();
    await projectWithSecrets();
    const row = liveProject(first.projectId)!;
    updateProject(first.projectId, row.customer_id, {
      model_key_enc: encryptModelKey("sk-lost", randomBytes(32), first.projectId)
    });
    expect(checkStoredSecrets().unreadable).toEqual([{ projectId: first.projectId, secret: "model key" }]);
    expect(cloudReadinessIssues()).toEqual([]);
  });

  it("reports a CLOUD_SECRET_KEY_PREVIOUS that is not a key", async () => {
    await projectWithSecrets();
    useKeys(OLD, "not-a-key");
    expect(cloudReadinessIssues()).toEqual(["cloud-secret-key-previous-invalid"]);
  });
});

describe("the database on /ready", () => {
  let directory = "";
  let file = "";

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "max-cloud-ready-"));
    file = path.join(directory, "cloud.sqlite");
    resetCloudDatabase(file);
  });

  afterEach(() => {
    resetCloudDatabase(":memory:");
    fs.rmSync(directory, { recursive: true, force: true });
  });

  /** The timestamp the readiness probe last wrote: undefined until it has run. */
  const probe = () =>
    immediate(
      (db) => (db.prepare("SELECT at FROM cloud_storage_probe WHERE id = 1").get() as { at: number } | undefined)?.at
    );

  it("is read and written before the relay is called ready, and probed again at most once a minute", async () => {
    await projectWithSecrets();
    expect(probe()).toBeUndefined();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      expect(cloudReadinessIssues()).toEqual([]);
      expect(probe()).toBe(1_000_000);
      // A load balancer asks every few seconds: the write is not repeated each time.
      expect(cloudReadinessIssues()).toEqual([]);
      expect(probe()).toBe(1_000_000);
      now.mockReturnValue(2_000_000);
      clock += 60_000;
      expect(cloudReadinessIssues()).toEqual([]);
      expect(probe()).toBe(2_000_000);
    } finally {
      now.mockRestore();
    }
  });

  it("is reported when the database can be read but not written, and clears once it can", async () => {
    await projectWithSecrets();
    immediate((db) => db.exec("PRAGMA query_only = ON"));
    expect(cloudReadinessIssues()).toEqual(["cloud-storage-unavailable"]);
    resetCloudDatabase(file); // a fresh connection, read-write again
    resetCloudKeyCheck();
    expect(cloudReadinessIssues()).toEqual([]);
  });

  it("is reported when the database file cannot be opened", async () => {
    await projectWithSecrets();
    resetCloudDatabase(file);
    fs.rmSync(file, { force: true });
    fs.mkdirSync(file); // a directory where the database file should be
    expect(cloudReadinessIssues()).toEqual(["cloud-storage-unavailable"]);
    fs.rmdirSync(file);
    resetCloudDatabase(file);
    resetCloudKeyCheck();
    expect(cloudReadinessIssues()).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)("is reported when its file and folder are read-only", async () => {
    await projectWithSecrets();
    resetCloudDatabase(file);
    fs.chmodSync(file, 0o400);
    fs.chmodSync(directory, 0o500);
    expect(cloudReadinessIssues()).toEqual(["cloud-storage-unavailable"]);
    fs.chmodSync(directory, 0o700);
    fs.chmodSync(file, 0o600);
    resetCloudDatabase(file);
    resetCloudKeyCheck();
    expect(cloudReadinessIssues()).toEqual([]);
  });
});
