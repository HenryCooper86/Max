// Max Cloud's database file: that a write the relay has acknowledged is on
// disk before the relay goes on, and how it is copied for a backup and settled by hand.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProject, signup } from "../server/cloud/customers";
import { adjustBalance, backupDatabase, immediate, insertOrder, resetCloudDatabase } from "../server/cloud/store";

const require = createRequire(import.meta.url);
const tsxImport = pathToFileURL(require.resolve("tsx")).href;
const ENV_NAMES = ["CLOUD_SECRET_KEY", "CLOUD_SIGNUP", "STUDIO_DIR"] as const;
const savedEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
let directory = "";
let file = "";

beforeEach(() => {
  process.env.CLOUD_SECRET_KEY = randomBytes(32).toString("base64");
  process.env.CLOUD_SIGNUP = "open";
  // A file, as on a relay: what is written is in the write-ahead log, not only in the database file.
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "max-cloud-store-"));
  file = path.join(directory, "cloud.sqlite");
  resetCloudDatabase(file);
});

afterEach(() => {
  resetCloudDatabase();
  vi.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

/** A customer with a project and a manual credit, as a relay that has run a while has. */
async function customerWithBalance(): Promise<{ email: string; customerId: string; projectId: string }> {
  const account = await signup(`c${randomBytes(4).toString("hex")}@example.com`, "correct horse battery");
  if (!account.ok) throw new Error(account.error);
  const { customer } = account.value;
  const project = createProject(customer.id, { name: "Shop" });
  if (!project.ok) throw new Error(project.error);
  adjustBalance({ customerId: customer.id, amountFen: 5_000, ref: "manual:INV-1", at: Date.now() });
  return { email: customer.email, customerId: customer.id, projectId: project.value.project.id };
}

/** What a restored relay reads: the copy by itself, with no `-wal` file beside it. */
function rows(copy: string, sql: string): Record<string, unknown>[] {
  const opened = new DatabaseSync(copy, { readOnly: true });
  try {
    return opened
      .prepare(sql)
      .all()
      .map((row) => ({ ...row }));
  } finally {
    opened.close();
  }
}

/** Runs one of the operator scripts where the relay's data lives in `studioDir`. */
function runScript(script: string, args: string[], studioDir: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ["--import", tsxImport, `scripts/${script}`, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, STUDIO_DIR: studioDir, ...env },
    encoding: "utf8"
  });
}

describe("the database file", () => {
  it("has every acknowledged commit on disk before the relay goes on", () => {
    // synchronous 2 is FULL. With NORMAL (1), which the relay used to set, a commit it had already answered
    // (a top-up credited) can be lost when the operating system crashes or the power fails.
    const pragmas = immediate((db) => {
      const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      const sync = db.prepare("PRAGMA synchronous").get() as { synchronous: number };
      return { journal_mode: mode.journal_mode, synchronous: sync.synchronous };
    });
    expect(pragmas).toEqual({ journal_mode: "wal", synchronous: 2 });
  });
});

describe("a backup of it", () => {
  it("is one consistent copy of everything committed so far, taken while the relay keeps running", async () => {
    const { email, customerId, projectId } = await customerWithBalance();
    const backups = path.join(directory, "backups");
    fs.mkdirSync(backups);
    const target = path.join(backups, "max-cloud-2026-11-25.sqlite");
    expect(fs.existsSync(`${file}-wal`)).toBe(true);

    expect(backupDatabase(target)).toBe(target);

    expect(fs.readdirSync(backups)).toEqual(["max-cloud-2026-11-25.sqlite"]);
    // It holds what the database holds (customers, their projects, the ledger), and only its owner can read it.
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(rows(target, "SELECT email FROM customers")).toEqual([{ email }]);
    expect(rows(target, "SELECT id FROM projects")).toEqual([{ id: projectId }]);
    expect(rows(target, "SELECT amount_fen, ref FROM ledger")).toEqual([{ amount_fen: 5_000, ref: "manual:INV-1" }]);
    expect(rows(target, "PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    // What the relay writes afterwards stays out of it.
    adjustBalance({ customerId, amountFen: 1_000, ref: "manual:INV-2", at: Date.now() });
    expect(rows(target, "SELECT COUNT(*) AS entries FROM ledger")).toEqual([{ entries: 1 }]);
  });

  it("never overwrites an existing file, and leaves nothing behind when the copy fails", async () => {
    await customerWithBalance();
    const existing = path.join(directory, "existing.sqlite");
    fs.writeFileSync(existing, "an earlier backup");
    expect(() => backupDatabase(existing)).toThrow(/already exists/);
    expect(fs.readFileSync(existing, "utf8")).toBe("an earlier backup");
    expect(() => backupDatabase(path.join(directory, "no-such-folder", "cloud.sqlite"))).toThrow(/no folder/);

    // The copy fails where the database file cannot even be created, and once it is made but cannot be put in
    // place (the disk is full): no file is left at the target, and none beside it.
    const unmakeable = path.join(directory, `${"x".repeat(300)}.sqlite`);
    expect(() => backupDatabase(unmakeable)).toThrow(/could not be written/);
    const target = path.join(directory, "max-cloud.sqlite");
    const diskFull = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    vi.spyOn(fs, "copyFileSync").mockImplementation(() => {
      throw diskFull;
    });
    expect(() => backupDatabase(target)).toThrow(/no space left on device/);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(directory).filter((name) => name.includes("partial"))).toEqual([]);
  });

  it("is made by the backup script while the relay keeps running, and an existing copy is kept", async () => {
    const { email } = await customerWithBalance();
    const target = path.join(directory, "max-cloud-backup.sqlite");
    const first = runScript("cloud-backup.ts", [target], directory);
    expect([first.status, first.stdout]).toEqual([0, expect.stringContaining(`Copied ${file} to ${target}`)]);
    expect(rows(target, "SELECT email FROM customers")).toEqual([{ email }]);
    const again = runScript("cloud-backup.ts", [target], directory);
    expect([again.status, again.stderr]).toEqual([1, expect.stringContaining("already exists")]);
    expect(rows(target, "SELECT COUNT(*) AS entries FROM ledger")).toEqual([{ entries: 1 }]);
  }, 20_000);

  it("is refused where there is no database, without making one", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "max-cloud-store-empty-"));
    try {
      const run = runScript("cloud-backup.ts", [path.join(directory, "none.sqlite")], empty);
      expect([run.status, run.stderr]).toEqual([1, expect.stringContaining("There is no Max Cloud database")]);
      expect(fs.readdirSync(empty)).toEqual([]);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("the settle script", () => {
  const ORDER = "mc2026111809000012345678abcdef";

  /** Stores an order closed as unpaid a day ago. */
  function closedOrder(customerId: string, provider: string) {
    insertOrder({
      id: ORDER,
      customer_id: customerId,
      provider,
      pack: "cny200",
      amount_fen: 20_000,
      status: "closed",
      provider_txn_id: null,
      created_at: Date.now() - 2 * 86_400_000,
      paid_at: null,
      expires_at: Date.now() - 86_400_000
    });
  }

  it("refuses an order the relay has no record of, and one whose provider is not configured", async () => {
    const { customerId } = await customerWithBalance();
    closedOrder(customerId, "wechat");
    const unknown = runScript("cloud-settle.ts", ["mcunknown0000000000000000000000"], directory);
    expect([unknown.status, unknown.stderr]).toEqual([1, expect.stringContaining("no Max Cloud order")]);
    const unconfigured = runScript("cloud-settle.ts", [ORDER], directory);
    expect([unconfigured.status, unconfigured.stderr]).toEqual([1, expect.stringContaining("not configured")]);
  }, 20_000);

  it("asks the provider itself, and credits nothing when it says the order was not paid", async () => {
    const { customerId } = await customerWithBalance();
    // The development-only provider is on in the script's environment; it has no record of this order.
    closedOrder(customerId, "test");
    const run = runScript("cloud-settle.ts", [ORDER], directory, {
      CLOUD_PAYMENTS_TEST: "on",
      CLOUD_PUBLIC_URL: "http://localhost:8787"
    });
    expect([run.status, run.stdout]).toEqual([0, expect.stringContaining("as not paid")]);
    expect(rows(file, "SELECT status FROM orders")).toEqual([{ status: "closed" }]);
    expect(rows(file, "SELECT COUNT(*) AS topups FROM ledger WHERE kind = 'topup'")).toEqual([{ topups: 0 }]);
  }, 20_000);
});
