// A Max Cloud database from before per-user usage opens with today's store
// and gains the new schema (the user_usage table, projects.per_user_minutes_cap
// and live_sessions.user_id) without losing what it already held. The old
// schema below is the CREATE block of server/cloud/store.ts at commit
// 70bb3d4a, plus the `monthly_minutes_cap` column that release had already
// added to `projects`: per-user usage did not exist yet, so there is no
// `user_usage` table, no `per_user_minutes_cap` and no `user_id`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { monthOf } from "../server/cloud/billing";
import { userLimitRefusal } from "../server/cloud/live";
import {
  bookUsage,
  customerById,
  immediate,
  ledgerEntries,
  perUserMinutesCap,
  projectMinutesCap,
  resetCloudDatabase,
  updateProject,
  userSecondsIn,
  userUsageTotals
} from "../server/cloud/store";

// The CREATE statements of the Cloud database before per-user usage. The base
// tables are verbatim from commit 70bb3d4a:server/cloud/store.ts.
const PRE_USER_USAGE_SCHEMA = `
  CREATE TABLE customers (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE customer_sessions (
    token_hash TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES customers(id),
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX idx_customer_sessions_customer ON customer_sessions(customer_id, expires_at);
  CREATE INDEX idx_customer_sessions_expiry ON customer_sessions(expires_at);
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES customers(id),
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    backend TEXT NOT NULL CHECK (backend IN ('openai', 'gemini', 'grok')),
    model_key_enc TEXT NULL,
    assistant_name TEXT NOT NULL DEFAULT '',
    instructions TEXT NOT NULL DEFAULT '',
    greeting TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    deleted_at INTEGER NULL
  );
  CREATE INDEX idx_projects_created ON projects(created_at);
  CREATE INDEX idx_projects_customer ON projects(customer_id, deleted_at, created_at);
  CREATE TABLE ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id TEXT NOT NULL REFERENCES customers(id),
    kind TEXT NOT NULL CHECK (kind IN ('topup', 'usage', 'adjust')),
    amount_fen INTEGER NOT NULL,
    free_seconds INTEGER NOT NULL DEFAULT 0,
    seconds INTEGER NOT NULL DEFAULT 0,
    project_id TEXT NULL,
    ref TEXT NULL,
    month TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (kind, ref)
  );
  CREATE INDEX idx_ledger_customer ON ledger(customer_id, id);
  CREATE INDEX idx_ledger_customer_month_free ON ledger(customer_id, kind, month, free_seconds);
  CREATE TABLE orders (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES customers(id),
    provider TEXT NOT NULL,
    pack TEXT NOT NULL,
    amount_fen INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'closed')),
    provider_txn_id TEXT NULL,
    created_at INTEGER NOT NULL,
    paid_at INTEGER NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX idx_orders_customer ON orders(customer_id, created_at);
  CREATE TABLE cloud_storage_probe (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    at INTEGER NOT NULL
  );
  CREATE TABLE cloud_invites (
    code TEXT PRIMARY KEY,
    note TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_by TEXT NULL,
    used_at INTEGER NULL
  );
  CREATE TABLE password_resets (
    customer_id TEXT PRIMARY KEY REFERENCES customers(id),
    token_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE live_sessions (
    session_id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL,
    seconds INTEGER NOT NULL,
    source TEXT NOT NULL,
    preview TEXT NOT NULL DEFAULT '',
    turns TEXT NOT NULL
  );
  CREATE INDEX idx_conversations_project ON conversations(project_id, started_at);
  CREATE INDEX idx_conversations_age ON conversations(started_at);
  -- monthly_minutes_cap was already added by the release that preceded
  -- per-user usage (the same commit's column migration); it is part of the
  -- old schema and must survive the upgrade.
  ALTER TABLE projects ADD COLUMN monthly_minutes_cap INTEGER NULL;
`;

const START = Date.UTC(2026, 10, 18, 12, 0, 0);
const MONTH = monthOf(START);
const CUSTOMER_ID = "cus_old1";
const PROJECT_ID = "prj_old1";

let directory = "";
let file = "";

/** Builds the pre-per-user database the way that release's relay left it, with realistic rows. */
function buildOldDatabase(): void {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "max-cloud-upgrade-"));
  file = path.join(directory, "cloud.sqlite");
  const db = new DatabaseSync(file);
  try {
    db.exec(PRE_USER_USAGE_SCHEMA);
    db.prepare(
      `INSERT INTO customers (id, email, password_hash, password_salt, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(CUSTOMER_ID, "old@example.com", "hash", "salt", START);
    db.prepare(
      `INSERT INTO projects (id, customer_id, name, key_hash, key_prefix, backend, model_key_enc,
         assistant_name, instructions, greeting, monthly_minutes_cap, created_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    ).run(
      PROJECT_ID,
      CUSTOMER_ID,
      "Old shop",
      "old-key-hash",
      "old-key-",
      "openai",
      null,
      "Assistant",
      "",
      "",
      100,
      START
    );
    const ledger = db.prepare(
      `INSERT INTO ledger (customer_id, kind, amount_fen, free_seconds, seconds, project_id, ref, month, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    ledger.run(CUSTOMER_ID, "topup", 5_000, 0, 0, null, "topup:INV-1", MONTH, START);
    ledger.run(CUSTOMER_ID, "usage", -75, 0, 300, PROJECT_ID, "old-session", MONTH, START);
    db.prepare(
      `INSERT INTO live_sessions (session_id, customer_id, project_id, started_at, last_seen)
       VALUES (?, ?, ?, ?, ?)`
    ).run("old-live-session", CUSTOMER_ID, PROJECT_ID, START, START + 30_000);
  } finally {
    db.close();
  }
}

function tableNames(): string[] {
  return immediate(
    (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function columns(table: string): string[] {
  return immediate((db) => db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (column) => column.name
  );
}

function indexNames(): string[] {
  return immediate(
    (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>
  ).map((row) => row.name);
}

beforeEach(() => {
  buildOldDatabase();
});

afterEach(() => {
  resetCloudDatabase();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("opening a pre-per-user database", () => {
  it("adds the user_usage table, per_user_minutes_cap, user_id and the usage index, keeping old rows", () => {
    resetCloudDatabase(file);
    expect(tableNames()).toContain("user_usage");
    expect(columns("projects")).toContain("per_user_minutes_cap");
    expect(columns("live_sessions")).toContain("user_id");
    expect(indexNames()).toContain("idx_user_usage_month_seconds");

    // The old rows are intact: the owner's monthly cap survived, the new
    // per-user cap and the session's user are still the schema's NULL.
    expect(projectMinutesCap(PROJECT_ID)).toBe(100);
    expect(perUserMinutesCap(PROJECT_ID)).toBeNull();
    const oldSession = immediate(
      (db) =>
        db.prepare("SELECT * FROM live_sessions WHERE session_id = ?").get("old-live-session") as
          Record<string, unknown> | undefined
    );
    expect(oldSession).toMatchObject({
      session_id: "old-live-session",
      customer_id: CUSTOMER_ID,
      project_id: PROJECT_ID,
      started_at: START,
      last_seen: START + 30_000,
      user_id: null
    });

    // The ledger rows and the balance they add up to are what they were.
    expect(ledgerEntries(CUSTOMER_ID, 10)).toHaveLength(2);
    expect(customerById(CUSTOMER_ID)?.balance_fen).toBe(5_000 - 75);
  });

  it("writes a new booking to user_usage under the session's user", () => {
    resetCloudDatabase(file);
    const outcome = bookUsage({
      customerId: CUSTOMER_ID,
      projectId: PROJECT_ID,
      sessionId: "new-session",
      userId: "u1",
      seconds: 120,
      endedAt: START,
      at: START
    });
    expect(outcome).toBe("booked");
    expect(userUsageTotals(PROJECT_ID, MONTH)).toEqual({ users: 1, sessions: 1, seconds: 120 });
    expect(userSecondsIn(PROJECT_ID, "u1", MONTH)).toBe(120);
    // The old ledger entries are untouched by the new booking.
    expect(ledgerEntries(CUSTOMER_ID, 10)).toHaveLength(3);
  });

  it("enforces the per-user minutes cap once one is set", () => {
    resetCloudDatabase(file);
    bookUsage({
      customerId: CUSTOMER_ID,
      projectId: PROJECT_ID,
      sessionId: "capped-user-session",
      userId: "u1",
      seconds: 120,
      endedAt: START,
      at: START
    });
    expect(updateProject(PROJECT_ID, CUSTOMER_ID, { per_user_minutes_cap: 1 })).toBe(true);
    expect(perUserMinutesCap(PROJECT_ID)).toBe(1);
    // 120 seconds of a 1-minute allowance is over it.
    expect(userLimitRefusal(PROJECT_ID, "u1", START)).toMatchObject({ reason: "user monthly limit" });
    // A user with nothing booked is still under it.
    expect(userLimitRefusal(PROJECT_ID, "u2", START)).toBeUndefined();
  });

  it("opens the same database a second time without losing or duplicating anything", () => {
    resetCloudDatabase(file);
    expect(
      bookUsage({
        customerId: CUSTOMER_ID,
        projectId: PROJECT_ID,
        sessionId: "first-open",
        userId: "u1",
        seconds: 60,
        endedAt: START,
        at: START
      })
    ).toBe("booked");

    // Reopening runs the migration again; the guarded columns and the
    // CREATE IF NOT EXISTS table must make it a no-op rather than an error.
    resetCloudDatabase(file);
    expect(columns("projects").filter((name) => name === "per_user_minutes_cap")).toHaveLength(1);
    expect(columns("live_sessions").filter((name) => name === "user_id")).toHaveLength(1);
    expect(userUsageTotals(PROJECT_ID, MONTH)).toEqual({ users: 1, sessions: 1, seconds: 60 });

    // And the reopened database still books new usage.
    expect(
      bookUsage({
        customerId: CUSTOMER_ID,
        projectId: PROJECT_ID,
        sessionId: "second-open",
        userId: "u2",
        seconds: 30,
        endedAt: START,
        at: START
      })
    ).toBe("booked");
    expect(userUsageTotals(PROJECT_ID, MONTH)).toEqual({ users: 2, sessions: 2, seconds: 90 });
  });
});
