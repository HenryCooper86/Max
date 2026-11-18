// Max Cloud's SQLite store ($STUDIO_DIR/cloud.sqlite): customers, their login
// sessions, projects, the money ledger and top-up orders. Every SQL statement
// of Max Cloud lives here. Balances change only through ledger rows, and the
// two writes that move money (booking a session, crediting a paid order) each
// run in one BEGIN IMMEDIATE transaction, idempotent on UNIQUE(kind, ref).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureTestingStorageDirectorySync, secureTestingFileSync } from "../testing-storage";
import { freeSecondsLeft, monthOf, usageCharge } from "./billing";

export type Backend = "openai" | "gemini" | "grok";
type OrderStatus = "pending" | "paid" | "closed";

export type CustomerRow = {
  id: string;
  email: string;
  password_hash: string;
  password_salt: string;
  created_at: number;
};

export type ProjectRow = {
  id: string;
  customer_id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  backend: Backend;
  model_key_enc: string | null;
  assistant_name: string;
  instructions: string;
  greeting: string;
  created_at: number;
  deleted_at: number | null;
};

export type OrderRow = {
  id: string;
  customer_id: string;
  provider: string;
  pack: string;
  amount_fen: number;
  status: OrderStatus;
  provider_txn_id: string | null;
  created_at: number;
  paid_at: number | null;
  expires_at: number;
};

export type LedgerRow = {
  id: number;
  kind: "topup" | "usage" | "adjust";
  amount_fen: number;
  seconds: number;
  project_id: string | null;
  ref: string | null;
  created_at: number;
};

const MAX_SESSIONS_PER_CUSTOMER = 20;

let databaseInstance: DatabaseSync | null = null;
let pathOverride: string | undefined;

function resolveDatabasePath(): string {
  if (pathOverride) return pathOverride;
  const directory = process.env.STUDIO_DIR?.trim();
  // Never touch the real home directory from a test run that did not ask for a file.
  if (!directory && process.env.NODE_ENV === "test") return ":memory:";
  return path.join(directory || path.join(os.homedir(), ".max-relay"), "cloud.sqlite");
}

/** Test seam: closes the open database; the next access opens `file` (":memory:" for a fresh
 * in-memory one), or the default location when omitted. */
export function resetCloudDatabase(file?: string): void {
  databaseInstance?.close();
  databaseInstance = null;
  pathOverride = file;
}

function secureDatabaseFiles(filePath: string): void {
  secureTestingFileSync(filePath);
  secureTestingFileSync(`${filePath}-wal`);
  secureTestingFileSync(`${filePath}-shm`);
}

function database(): DatabaseSync {
  if (databaseInstance) return databaseInstance;
  const filePath = resolveDatabasePath();
  const onDisk = filePath !== ":memory:";
  if (onDisk) {
    ensureTestingStorageDirectorySync(filePath);
    // Create the file private before SQLite opens it, so it is never readable by others.
    fs.closeSync(fs.openSync(filePath, "a", 0o600));
    secureDatabaseFiles(filePath);
  }
  const db = new DatabaseSync(filePath);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    if (onDisk) {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL");
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS customer_sessions (
        token_hash TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customers(id),
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_customer_sessions_customer ON customer_sessions(customer_id, expires_at);
      CREATE INDEX IF NOT EXISTS idx_customer_sessions_expiry ON customer_sessions(expires_at);
      CREATE TABLE IF NOT EXISTS projects (
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
      CREATE INDEX IF NOT EXISTS idx_projects_customer ON projects(customer_id, deleted_at, created_at);
      CREATE TABLE IF NOT EXISTS ledger (
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
      CREATE INDEX IF NOT EXISTS idx_ledger_customer ON ledger(customer_id, id);
      CREATE INDEX IF NOT EXISTS idx_ledger_customer_month ON ledger(customer_id, kind, month);
      CREATE TABLE IF NOT EXISTS orders (
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
      CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id, created_at);
    `);
  } catch (error) {
    db.close();
    throw error;
  }
  if (onDisk) secureDatabaseFiles(filePath);
  databaseInstance = db;
  return db;
}

/** Runs `work` (synchronous) in one BEGIN IMMEDIATE transaction. */
function immediate<T>(work: (db: DatabaseSync) => T): T {
  const db = database();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work(db);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* the transaction is already gone */
    }
    throw error;
  }
}

// --- customers and their sessions -------------------------------------------

/** Inserts a customer; false when the email is taken. */
export function insertCustomer(row: CustomerRow): boolean {
  const result = database()
    .prepare(
      `INSERT INTO customers (id, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(email) DO NOTHING`
    )
    .run(row.id, row.email, row.password_hash, row.password_salt, row.created_at);
  return result.changes === 1;
}

export function customerByEmail(email: string): CustomerRow | undefined {
  return database().prepare("SELECT * FROM customers WHERE email = ?").get(email) as CustomerRow | undefined;
}

/** Stores a login session, keeping at most the newest 20 per customer. */
export function insertSession(tokenHash: string, customerId: string, expiresAt: number, at: number): void {
  immediate((db) => {
    db.prepare("DELETE FROM customer_sessions WHERE expires_at <= ?").run(at);
    db.prepare("INSERT INTO customer_sessions (token_hash, customer_id, expires_at) VALUES (?, ?, ?)").run(
      tokenHash,
      customerId,
      expiresAt
    );
    db.prepare(
      `DELETE FROM customer_sessions WHERE customer_id = ? AND token_hash NOT IN (
         SELECT token_hash FROM customer_sessions WHERE customer_id = ? ORDER BY expires_at DESC LIMIT ?
       )`
    ).run(customerId, customerId, MAX_SESSIONS_PER_CUSTOMER);
  });
}

/** The customer behind a live session; an expired session is deleted. */
export function sessionCustomer(tokenHash: string, at: number): CustomerRow | undefined {
  const db = database();
  const session = db
    .prepare("SELECT customer_id, expires_at FROM customer_sessions WHERE token_hash = ?")
    .get(tokenHash) as { customer_id: string; expires_at: number } | undefined;
  if (!session) return undefined;
  if (session.expires_at <= at) {
    deleteSession(tokenHash);
    return undefined;
  }
  return db.prepare("SELECT * FROM customers WHERE id = ?").get(session.customer_id) as CustomerRow | undefined;
}

export function deleteSession(tokenHash: string): void {
  database().prepare("DELETE FROM customer_sessions WHERE token_hash = ?").run(tokenHash);
}

// --- projects -------------------------------------------------------------------

/** Inserts a project unless the customer already has `limit` live ones. */
export function insertProject(row: ProjectRow, limit: number): boolean {
  return immediate((db) => {
    const { count } = db
      .prepare("SELECT COUNT(*) AS count FROM projects WHERE customer_id = ? AND deleted_at IS NULL")
      .get(row.customer_id) as { count: number };
    if (count >= limit) return false;
    db.prepare(
      `INSERT INTO projects (id, customer_id, name, key_hash, key_prefix, backend, model_key_enc, assistant_name,
         instructions, greeting, created_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    ).run(
      row.id,
      row.customer_id,
      row.name,
      row.key_hash,
      row.key_prefix,
      row.backend,
      row.model_key_enc,
      row.assistant_name,
      row.instructions,
      row.greeting,
      row.created_at
    );
    return true;
  });
}

export function liveProjects(customerId: string): ProjectRow[] {
  return database()
    .prepare("SELECT * FROM projects WHERE customer_id = ? AND deleted_at IS NULL ORDER BY created_at, id")
    .all(customerId) as ProjectRow[];
}

/** A live project, optionally only when it belongs to `customerId`. */
export function liveProject(projectId: string, customerId?: string): ProjectRow | undefined {
  const row = database().prepare("SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL").get(projectId) as
    ProjectRow | undefined;
  if (!row || (customerId !== undefined && row.customer_id !== customerId)) return undefined;
  return row;
}

export function liveProjectByKeyHash(keyHash: string): ProjectRow | undefined {
  return database().prepare("SELECT * FROM projects WHERE key_hash = ? AND deleted_at IS NULL").get(keyHash) as
    ProjectRow | undefined;
}

export type ProjectChanges = Partial<
  Pick<ProjectRow, "name" | "backend" | "model_key_enc" | "assistant_name" | "instructions" | "greeting">
>;

const PROJECT_COLUMNS = ["name", "backend", "model_key_enc", "assistant_name", "instructions", "greeting"] as const;

/** Applies changes to a live project of `customerId`; false when there is no such project. */
export function updateProject(projectId: string, customerId: string, changes: ProjectChanges): boolean {
  const columns = PROJECT_COLUMNS.filter((column) => changes[column] !== undefined);
  if (!columns.length) return Boolean(liveProject(projectId, customerId));
  const assignments = columns.map((column) => `${column} = ?`).join(", ");
  const values = columns.map((column) => changes[column] ?? null);
  const result = database()
    .prepare(`UPDATE projects SET ${assignments} WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`)
    .run(...values, projectId, customerId);
  return result.changes === 1;
}

export function replaceProjectKey(projectId: string, customerId: string, keyHash: string, keyPrefix: string): boolean {
  const result = database()
    .prepare("UPDATE projects SET key_hash = ?, key_prefix = ? WHERE id = ? AND customer_id = ? AND deleted_at IS NULL")
    .run(keyHash, keyPrefix, projectId, customerId);
  return result.changes === 1;
}

export function softDeleteProject(projectId: string, customerId: string, at: number): boolean {
  const result = database()
    .prepare("UPDATE projects SET deleted_at = ? WHERE id = ? AND customer_id = ? AND deleted_at IS NULL")
    .run(at, projectId, customerId);
  return result.changes === 1;
}

// --- ledger ---------------------------------------------------------------------

function freeSecondsUsedIn(db: DatabaseSync, customerId: string, month: string): number {
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(free_seconds), 0) AS used FROM ledger WHERE customer_id = ? AND kind = 'usage' AND month = ?"
    )
    .get(customerId, month) as { used: number };
  return row.used;
}

function balanceIn(db: DatabaseSync, customerId: string): number {
  const row = db
    .prepare("SELECT COALESCE(SUM(amount_fen), 0) AS fen FROM ledger WHERE customer_id = ?")
    .get(customerId) as { fen: number };
  return row.fen;
}

/** Balance in fen and free seconds left in the month of `at`. */
export function customerFunds(customerId: string, at: number): { fen: number; freeSecondsLeft: number; month: string } {
  const db = database();
  const month = monthOf(at);
  return {
    fen: balanceIn(db, customerId),
    freeSecondsLeft: freeSecondsLeft(freeSecondsUsedIn(db, customerId, month)),
    month
  };
}

export type UsageBooking = {
  customerId: string;
  projectId: string;
  sessionId: string;
  /** Whole seconds. */
  seconds: number;
  endedAt: number;
  at: number;
};

/** Books one session's usage; false when that session was already booked. */
export function bookUsage(usage: UsageBooking): boolean {
  return immediate((db) => {
    const existing = db.prepare("SELECT 1 FROM ledger WHERE kind = 'usage' AND ref = ?").get(usage.sessionId);
    if (existing) return false;
    const month = monthOf(usage.endedAt);
    const left = freeSecondsLeft(freeSecondsUsedIn(db, usage.customerId, month));
    const { freeSeconds, costFen } = usageCharge(usage.seconds, left);
    db.prepare(
      `INSERT INTO ledger (customer_id, kind, amount_fen, free_seconds, seconds, project_id, ref, month, created_at)
       VALUES (?, 'usage', ?, ?, ?, ?, ?, ?, ?)`
    ).run(usage.customerId, -costFen, freeSeconds, usage.seconds, usage.projectId, usage.sessionId, month, usage.at);
    return true;
  });
}

/**
 * A manual change to a customer's balance in fen (positive adds credit), for
 * payments the owner received some other way: a bank transfer, an invoice.
 * Idempotent on `ref` (an invoice or receipt number), so running the same
 * credit twice adds it once. Returns false when `ref` was already used.
 */
export function adjustBalance(entry: { customerId: string; amountFen: number; ref: string; at: number }): boolean {
  return immediate((db) => {
    if (db.prepare("SELECT 1 FROM ledger WHERE kind = 'adjust' AND ref = ?").get(entry.ref)) return false;
    db.prepare(
      `INSERT INTO ledger (customer_id, kind, amount_fen, free_seconds, seconds, project_id, ref, month, created_at)
       VALUES (?, 'adjust', ?, 0, 0, NULL, ?, ?, ?)`
    ).run(entry.customerId, entry.amountFen, entry.ref, monthOf(entry.at), entry.at);
    return true;
  });
}

export function ledgerEntries(customerId: string, limit: number): LedgerRow[] {
  return database()
    .prepare(
      `SELECT id, kind, amount_fen, seconds, project_id, ref, created_at FROM ledger
       WHERE customer_id = ? ORDER BY id DESC LIMIT ?`
    )
    .all(customerId, limit) as LedgerRow[];
}

export type UsageSummary = {
  seconds: number;
  freeSecondsUsed: number;
  chargedFen: number;
  projects: Array<{ projectId: string; name: string; seconds: number; chargedFen: number }>;
};

export function usageSummary(customerId: string, month: string): UsageSummary {
  const db = database();
  const totals = db
    .prepare(
      `SELECT COALESCE(SUM(seconds), 0) AS seconds, COALESCE(SUM(free_seconds), 0) AS free_seconds,
         COALESCE(-SUM(amount_fen), 0) AS charged_fen
       FROM ledger WHERE customer_id = ? AND kind = 'usage' AND month = ?`
    )
    .get(customerId, month) as { seconds: number; free_seconds: number; charged_fen: number };
  const projects = db
    .prepare(
      `SELECT l.project_id AS project_id, COALESCE(p.name, '') AS name, SUM(l.seconds) AS seconds,
         -SUM(l.amount_fen) AS charged_fen
       FROM ledger l LEFT JOIN projects p ON p.id = l.project_id AND p.customer_id = l.customer_id
       WHERE l.customer_id = ? AND l.kind = 'usage' AND l.month = ? AND l.project_id IS NOT NULL
       GROUP BY l.project_id ORDER BY seconds DESC, l.project_id`
    )
    .all(customerId, month) as Array<{ project_id: string; name: string; seconds: number; charged_fen: number }>;
  return {
    seconds: totals.seconds,
    freeSecondsUsed: totals.free_seconds,
    chargedFen: totals.charged_fen,
    projects: projects.map((row) => ({
      projectId: row.project_id,
      name: row.name,
      seconds: row.seconds,
      chargedFen: row.charged_fen
    }))
  };
}

// --- orders -----------------------------------------------------------------------

export function insertOrder(row: OrderRow): void {
  database()
    .prepare(
      `INSERT INTO orders (id, customer_id, provider, pack, amount_fen, status, provider_txn_id, created_at, paid_at,
         expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.id,
      row.customer_id,
      row.provider,
      row.pack,
      row.amount_fen,
      row.status,
      row.provider_txn_id,
      row.created_at,
      row.paid_at,
      row.expires_at
    );
}

export function orderById(orderId: string): OrderRow | undefined {
  return database().prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as OrderRow | undefined;
}

/** Closes a pending order; false when it was no longer pending. */
export function closePendingOrder(orderId: string): boolean {
  const result = database()
    .prepare("UPDATE orders SET status = 'closed' WHERE id = ? AND status = 'pending'")
    .run(orderId);
  return result.changes === 1;
}

export type CreditOutcome = "credited" | "duplicate" | "unknown-order" | "provider-mismatch" | "amount-mismatch";

/**
 * Marks a verified paid order paid and credits its amount, in one transaction.
 * A pending order is credited; so is one this relay closed (expired or failed
 * to create at the provider) that the provider has nevertheless verified as
 * paid, since the customer's money was taken. A paid order is a no-op.
 */
export function creditOrder(
  paid: { orderId: string; providerTxnId: string; amountFen: number },
  providerId: string,
  at: number
): CreditOutcome {
  return immediate((db) => {
    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(paid.orderId) as OrderRow | undefined;
    if (!order) return "unknown-order";
    if (order.provider !== providerId) return "provider-mismatch";
    if (order.amount_fen !== paid.amountFen) return "amount-mismatch";
    if (order.status === "paid") return "duplicate";
    const updated = db
      .prepare(
        "UPDATE orders SET status = 'paid', provider_txn_id = ?, paid_at = ? WHERE id = ? AND status IN ('pending', 'closed')"
      )
      .run(paid.providerTxnId, at, order.id);
    if (updated.changes !== 1) return "duplicate";
    db.prepare(
      `INSERT INTO ledger (customer_id, kind, amount_fen, free_seconds, seconds, project_id, ref, month, created_at)
       VALUES (?, 'topup', ?, 0, 0, NULL, ?, ?, ?)`
    ).run(order.customer_id, order.amount_fen, order.id, monthOf(at), at);
    return "credited";
  });
}

/** Pending orders of a customer that have not expired yet. */
export function openOrderCount(customerId: string, at: number): number {
  const row = database()
    .prepare("SELECT COUNT(*) AS count FROM orders WHERE customer_id = ? AND status = 'pending' AND expires_at > ?")
    .get(customerId, at) as { count: number };
  return row.count;
}

export function customerExists(customerId: string): boolean {
  return Boolean(database().prepare("SELECT 1 FROM customers WHERE id = ?").get(customerId));
}
