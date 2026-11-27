// Max Cloud's SQLite store ($STUDIO_DIR/cloud.sqlite): customers, their login
// sessions and password-reset links, projects, the money ledger, top-up
// orders and each project's usage per end user. Every SQL statement of Max
// Cloud lives here. Balances change only
// through ledger rows, which a trigger applies to the customer's `balance_fen`
// in the same transaction, and the two writes that move money (booking a
// session, crediting a paid order) each run in one BEGIN IMMEDIATE transaction,
// idempotent on UNIQUE(kind, ref).

import type { InstallSignalKind } from "../../shared/studio-install";
import type { StudioActivation } from "../../shared/cloud-studio";
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
  /** The sum of the customer's ledger in fen, kept on the row by the trigger ledger_entry_moves_balance. */
  balance_fen: number;
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
  /** JSON of ProjectStudio (shared/cloud-studio.ts). */
  studio: string;
  /** Public id for embedding without a backend (pub_…). */
  public_id: string | null;
  /** The webhook signing secret, encrypted like the model key. */
  webhook_secret_enc: string | null;
  /** The request headers of the project's trace collector (they carry its API key), encrypted like the model key. */
  traces_headers_enc: string | null;
  /** The owner's limit on this project's minutes per calendar month (UTC); null for none. */
  monthly_minutes_cap: number | null;
  /** The owner's limit on each end user's minutes in this project per calendar month (UTC); null for none. */
  per_user_minutes_cap: number | null;
  first_website_conversation_at: number | null;
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

/**
 * What deleting a project erases from its row: everything but what the
 * activation metrics and past usage need, which are its id, its owner, its
 * name, its backend (the schema has no neutral value for it) and its dates.
 * The Studio settings can hold addresses with tokens in them, and the rest is
 * what its owner wrote. `key_hash` can hold no NULL (it is NOT NULL and
 * UNIQUE), so it becomes a value no key hashes to; every other column goes
 * back to what a project has before its owner fills it in.
 */
const ERASED = {
  key_hash: "'deleted:' || id",
  key_prefix: "''",
  model_key_enc: "NULL",
  webhook_secret_enc: "NULL",
  traces_headers_enc: "NULL",
  assistant_name: "''",
  instructions: "''",
  greeting: "''",
  studio: "'{}'",
  public_id: "NULL",
  monthly_minutes_cap: "NULL",
  per_user_minutes_cap: "NULL",
  studio_revision: "NULL"
} as const;
/** The same, as what an UPDATE sets the columns to. */
const ERASE_TO = Object.entries(ERASED)
  .map(([column, value]) => `${column} = ${value}`)
  .join(", ");
/** The same, as the condition that a row still holds any of it. */
const NOT_ERASED = Object.entries(ERASED)
  .map(([column, value]) => `${column} IS NOT (${value})`)
  .join(" OR ");

let databaseInstance: DatabaseSync | null = null;
let pathOverride: string | undefined;

/** The file the database is opened at: `STUDIO_DIR/cloud.sqlite` (by default `~/.max-relay/cloud.sqlite`), the last
 *  file a test named, or ":memory:" for a test run that named none. */
export function cloudDatabasePath(): string {
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

/** Whether a deleted project still holds, on its row, in a saved revision or in its usage per end user, anything that deleting erases. */
function deletedProjectNotErased(db: DatabaseSync): boolean {
  const deleted = "SELECT id FROM projects WHERE deleted_at IS NOT NULL";
  return (
    db.prepare(`SELECT 1 FROM projects WHERE deleted_at IS NOT NULL AND (${NOT_ERASED}) LIMIT 1`).get() !== undefined ||
    db.prepare(`SELECT 1 FROM studio_snapshots WHERE project_id IN (${deleted}) LIMIT 1`).get() !== undefined ||
    db.prepare(`SELECT 1 FROM user_usage WHERE project_id IN (${deleted}) LIMIT 1`).get() !== undefined
  );
}

function database(): DatabaseSync {
  if (databaseInstance) return databaseInstance;
  const filePath = cloudDatabasePath();
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
      // FULL, not the NORMAL that suits most users of a write-ahead log: with NORMAL a commit the relay has already
      // acknowledged (a top-up credited) can still be lost when the operating system crashes or the power fails.
      db.exec("PRAGMA synchronous = FULL");
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
      CREATE INDEX IF NOT EXISTS idx_projects_created ON projects(created_at);
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
      CREATE INDEX IF NOT EXISTS idx_ledger_customer_month_free ON ledger(customer_id, kind, month, free_seconds);
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
      CREATE TABLE IF NOT EXISTS cloud_storage_probe (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cloud_invites (
        code TEXT PRIMARY KEY,
        note TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_by TEXT NULL,
        used_at INTEGER NULL
      );
      CREATE TABLE IF NOT EXISTS password_resets (
        customer_id TEXT PRIMARY KEY REFERENCES customers(id),
        token_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS live_sessions (
        session_id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversations (
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
      CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_conversations_age ON conversations(started_at);
      CREATE TABLE IF NOT EXISTS user_usage (
        project_id TEXT NOT NULL,
        month TEXT NOT NULL,
        user_id TEXT NOT NULL DEFAULT '',
        sessions INTEGER NOT NULL DEFAULT 0,
        seconds INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (project_id, month, user_id)
      ) WITHOUT ROWID;
    `);
    // Columns added after the first release: older databases gain them here.
    const projectColumns = new Set(
      (db.prepare("PRAGMA table_info(projects)").all() as { name: string }[]).map((column) => column.name)
    );
    if (!projectColumns.has("studio")) db.exec("ALTER TABLE projects ADD COLUMN studio TEXT NOT NULL DEFAULT '{}'");
    if (!projectColumns.has("public_id")) db.exec("ALTER TABLE projects ADD COLUMN public_id TEXT NULL");
    if (!projectColumns.has("webhook_secret_enc")) {
      db.exec("ALTER TABLE projects ADD COLUMN webhook_secret_enc TEXT NULL");
    }
    if (!projectColumns.has("traces_headers_enc")) {
      db.exec("ALTER TABLE projects ADD COLUMN traces_headers_enc TEXT NULL");
    }
    if (!projectColumns.has("monthly_minutes_cap")) {
      db.exec("ALTER TABLE projects ADD COLUMN monthly_minutes_cap INTEGER NULL");
    }
    if (!projectColumns.has("per_user_minutes_cap")) {
      db.exec("ALTER TABLE projects ADD COLUMN per_user_minutes_cap INTEGER NULL");
    }
    if (!projectColumns.has("first_website_conversation_at")) {
      // Older API sessions did not record their origin. Only retained embed exchanges prove a website install.
      db.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE projects ADD COLUMN first_website_conversation_at INTEGER;
        UPDATE projects SET first_website_conversation_at = (
          SELECT MIN(c.ended_at) FROM conversations c
          WHERE c.project_id = projects.id AND c.source = 'embed' AND (
            SELECT MIN(CASE WHEN turn.value ->> 'speaker' = 'user' THEN turn.key END)
                 < MAX(CASE WHEN turn.value ->> 'speaker' = 'agent' THEN turn.key END)
            FROM json_each(CASE WHEN json_valid(c.turns) THEN c.turns ELSE '[]' END) AS turn
            WHERE CASE WHEN turn.type = 'object' THEN trim(turn.value ->> 'text') <> '' ELSE 0 END
          )
        ) WHERE deleted_at IS NULL;
        COMMIT;
      `);
    }
    if (!projectColumns.has("studio_revision")) db.exec("ALTER TABLE projects ADD COLUMN studio_revision TEXT");
    db.exec(`
      CREATE TABLE IF NOT EXISTS studio_snapshots (
        project_id TEXT NOT NULL REFERENCES projects(id), role TEXT NOT NULL CHECK(role IN ('draft','previous')),
        revision TEXT NOT NULL, config TEXT NOT NULL, model_key_enc TEXT, traces_headers_enc TEXT,
        tested INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(project_id, role)
      );
      CREATE TABLE IF NOT EXISTS studio_replay_cases (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        id TEXT NOT NULL, version INTEGER NOT NULL,
        prompt TEXT NOT NULL, expected TEXT NOT NULL, fixtures TEXT NOT NULL,
        PRIMARY KEY(project_id, id)
      );
      CREATE TABLE IF NOT EXISTS studio_replay_results (
        project_id TEXT NOT NULL, id TEXT NOT NULL, revision TEXT NOT NULL, version INTEGER NOT NULL,
        outcome TEXT, PRIMARY KEY(project_id,id),
        FOREIGN KEY(project_id,id) REFERENCES studio_replay_cases(project_id,id) ON DELETE CASCADE
      );
      CREATE TRIGGER IF NOT EXISTS studio_replay_case_edited AFTER UPDATE OF version ON studio_replay_cases
      BEGIN UPDATE studio_replay_results SET outcome=NULL WHERE project_id=NEW.project_id AND id=NEW.id; END;
      CREATE TABLE IF NOT EXISTS website_install_signals (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, at INTEGER NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS website_install_project_deleted AFTER UPDATE OF deleted_at ON projects
      WHEN NEW.deleted_at IS NOT NULL
      BEGIN DELETE FROM website_install_signals WHERE project_id=OLD.id; END;
      CREATE TRIGGER IF NOT EXISTS studio_replay_project_deleted AFTER UPDATE OF deleted_at ON projects
      WHEN NEW.deleted_at IS NOT NULL
      BEGIN DELETE FROM studio_replay_cases WHERE project_id = OLD.id; END;
      CREATE TEMP TRIGGER IF NOT EXISTS studio_live_revision BEFORE UPDATE OF studio_revision ON projects
      WHEN OLD.studio_revision IS NOT NULL AND OLD.studio_revision IS NOT NEW.studio_revision
      BEGIN
        DELETE FROM studio_snapshots WHERE project_id = OLD.id;
        INSERT INTO studio_snapshots(project_id,role,revision,config,model_key_enc,traces_headers_enc)
        VALUES(OLD.id,'previous',OLD.studio_revision,json_object(
          'name',OLD.name,'backend',OLD.backend,'assistant_name',OLD.assistant_name,'instructions',OLD.instructions,
          'greeting',OLD.greeting,'studio',OLD.studio
        ),OLD.model_key_enc,OLD.traces_headers_enc);
      END;
    `);
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_public_id ON projects(public_id)");
    // The ledger reads of the 5-second check (server/cloud/live.ts) are covered by their indexes: a customer's free
    // seconds this month and a project's minutes this month are summed from the index alone, not row by row from
    // the table. Both indexes were narrower, as idx_ledger_customer_month and idx_ledger_project_month: those are
    // dropped, so that no database keeps both.
    db.exec("CREATE INDEX IF NOT EXISTS idx_ledger_project_month_seconds ON ledger(project_id, kind, month, seconds)");
    // The rows of a project's month by the seconds their users used, most first: what a usage report lists, read in
    // that order without sorting the month, and with the user id so the row itself need not be opened.
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_user_usage_month_seconds ON user_usage(project_id, month, seconds DESC, user_id)"
    );
    db.exec("DROP INDEX IF EXISTS idx_ledger_project_month");
    db.exec("DROP INDEX IF EXISTS idx_ledger_customer_month");
    // Orders by status and expiry, read once a minute by the top-up sweep. The index was called idx_orders_pending
    // before the sweep read closed orders too: drop that one, so that no database keeps both.
    db.exec("DROP INDEX IF EXISTS idx_orders_pending");
    db.exec("CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, expires_at)");
    const liveColumns = new Set(
      (db.prepare("PRAGMA table_info(live_sessions)").all() as { name: string }[]).map((column) => column.name)
    );
    if (!liveColumns.has("instance_id")) db.exec("ALTER TABLE live_sessions ADD COLUMN instance_id TEXT NULL");
    if (!liveColumns.has("seconds")) db.exec("ALTER TABLE live_sessions ADD COLUMN seconds REAL NULL");
    if (!liveColumns.has("ended_at")) db.exec("ALTER TABLE live_sessions ADD COLUMN ended_at INTEGER NULL");
    if (!liveColumns.has("user_id")) db.exec("ALTER TABLE live_sessions ADD COLUMN user_id TEXT NULL");
    const conversationColumns = new Set(
      (db.prepare("PRAGMA table_info(conversations)").all() as { name: string }[]).map((column) => column.name)
    );
    if (!conversationColumns.has("analysis")) db.exec("ALTER TABLE conversations ADD COLUMN analysis TEXT NULL");
    if (!conversationColumns.has("answer_ms")) db.exec("ALTER TABLE conversations ADD COLUMN answer_ms INTEGER NULL");
    const customerColumns = new Set(
      (db.prepare("PRAGMA table_info(customers)").all() as { name: string }[]).map((column) => column.name)
    );
    if (!customerColumns.has("balance_fen")) {
      // One write transaction from the column to the ledger sum that fills it, with the trigger that keeps that sum
      // created in between: no ledger entry, from whichever relay or script it comes, is missed by either.
      db.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE customers ADD COLUMN balance_fen INTEGER NOT NULL DEFAULT 0;
        CREATE TRIGGER ledger_entry_moves_balance AFTER INSERT ON ledger BEGIN
          UPDATE customers SET balance_fen = balance_fen + NEW.amount_fen WHERE id = NEW.customer_id; END;
        UPDATE customers SET balance_fen = (SELECT COALESCE(SUM(amount_fen), 0) FROM ledger WHERE customer_id = customers.id);
        COMMIT;
      `);
    }
    // A project deleted before everything a deletion erases was erased with it (softDeleteProject) is erased the first
    // time the database is opened after that. Nothing is written once none is left, so a read-only database still opens.
    if (deletedProjectNotErased(db)) {
      db.exec(`
        BEGIN IMMEDIATE;
        UPDATE projects SET ${ERASE_TO} WHERE deleted_at IS NOT NULL AND (${NOT_ERASED});
        DELETE FROM studio_snapshots WHERE project_id IN (SELECT id FROM projects WHERE deleted_at IS NOT NULL);
        DELETE FROM user_usage WHERE project_id IN (SELECT id FROM projects WHERE deleted_at IS NOT NULL);
        COMMIT;
      `);
    }
  } catch (error) {
    db.close();
    throw error;
  }
  if (onDisk) secureDatabaseFiles(filePath);
  databaseInstance = db;
  return db;
}

/** Runs `work` (synchronous) in one BEGIN IMMEDIATE transaction. */
export function immediate<T>(work: (db: DatabaseSync) => T): T {
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

// --- readiness --------------------------------------------------------------------

/**
 * Why the database cannot be read and written, for the readiness probe
 * (keyring.ts); undefined while it can be both. The read proves a table can be
 * read. The write proves a change reaches the disk, which only a commit can (a
 * rolled-back transaction proves just that the write lock could be taken), so
 * one row of cloud_storage_probe is rewritten and committed. Its caller makes
 * the probe at most once a minute, which keeps /ready cheap.
 */
export function cloudStorageProblem(): string | undefined {
  try {
    immediate((db) => {
      db.prepare("SELECT id FROM customers LIMIT 1").get();
      db.prepare(
        "INSERT INTO cloud_storage_probe (id, at) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET at = excluded.at"
      ).run(Date.now());
    });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Writes a consistent copy of the database to `target`, which must not exist
 * yet, and returns its path. The copy is taken with VACUUM INTO: one moment's
 * state of the whole database, read while the relay keeps writing. Copying the
 * files by hand is not the same: in WAL mode the newest commits are in the
 * `-wal` file, and a copy made mid-write may not open.
 *
 * The copy is written beside `target` first and put in place only once whole,
 * and is private like the database (it holds the same customers and encrypted
 * secrets). Throws when `target` exists, when its folder does not, or when the
 * copy cannot be written; nothing is left at `target` then.
 */
export function backupDatabase(target: string): string {
  const file = path.resolve(target);
  const folder = path.dirname(file);
  if (fs.existsSync(file)) throw new Error(`${file} already exists: an existing backup is never overwritten.`);
  if (!fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`There is no folder ${folder} to write the copy into.`);
  }
  const partial = `${file}.partial-${process.pid}`;
  try {
    database().prepare("VACUUM INTO ?").run(partial);
    secureTestingFileSync(partial);
    // Exclusive: the file is put in place only if nothing took its name meanwhile.
    fs.copyFileSync(partial, file, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`The copy of ${cloudDatabasePath()} could not be written to ${file}: ${reason}`, { cause: error });
  } finally {
    // Best effort: a copy left beside the target is harmless, and must not hide why writing it failed.
    try {
      fs.rmSync(partial, { force: true });
    } catch {
      /* nothing here can be cleaned up */
    }
  }
  // "Done" means on disk: what is still in the operating system's cache does not survive a power failure.
  const written = fs.openSync(file, "r+");
  try {
    fs.fsyncSync(written);
  } finally {
    fs.closeSync(written);
  }
  return file;
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

export function customerById(customerId: string): CustomerRow | undefined {
  return database().prepare("SELECT * FROM customers WHERE id = ?").get(customerId) as CustomerRow | undefined;
}

/** Stores a session (and prunes expired ones and past the newest 20) in the transaction `db` is in. */
function insertSessionIn(db: DatabaseSync, tokenHash: string, customerId: string, expiresAt: number, at: number): void {
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
}

/** Stores a login session, keeping at most the newest 20 per customer. */
export function insertSession(tokenHash: string, customerId: string, expiresAt: number, at: number): void {
  immediate((db) => insertSessionIn(db, tokenHash, customerId, expiresAt, at));
}

/**
 * Stores a login session only while the customer's password is still the one
 * that was verified (`verified`): a login that read the customer before a
 * password change or reset committed must not mint a session that survives the
 * revoke. False when the password moved on.
 */
export function insertSessionIfPasswordMatches(
  tokenHash: string,
  customerId: string,
  expiresAt: number,
  at: number,
  verified: StoredPassword
): boolean {
  return immediate((db) => {
    if (
      !db
        .prepare("SELECT 1 FROM customers WHERE id = ? AND password_hash = ? AND password_salt = ?")
        .get(customerId, verified.hash, verified.salt)
    ) {
      return false;
    }
    insertSessionIn(db, tokenHash, customerId, expiresAt, at);
    return true;
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

// Each write below is one transaction, so a password and the sessions it ends
// change together, whoever else is writing at the same time.

/** Ends every session of a customer and their password-reset link: signed out on every device, no pending link. */
export function deleteCustomerSessions(customerId: string): void {
  immediate((db) => {
    db.prepare("DELETE FROM customer_sessions WHERE customer_id = ?").run(customerId);
    db.prepare("DELETE FROM password_resets WHERE customer_id = ?").run(customerId);
  });
}

/** What a customer's `password_hash` and `password_salt` hold. */
type StoredPassword = { hash: string; salt: string };

/**
 * Sets the password of the customer behind a live session, and ends every
 * other session of theirs, in one transaction: the session that asked stays
 * signed in. `verified` is the stored password the current one was checked
 * against. "signed-out" when that session is no longer live, and
 * "changed-meanwhile" when the password is no longer that one (it was changed
 * or reset while the new one was being hashed): nothing changes then.
 */
export function replaceCustomerPassword(
  tokenHash: string,
  verified: StoredPassword,
  next: StoredPassword,
  at: number
): "changed" | "signed-out" | "changed-meanwhile" {
  return immediate((db) => {
    const session = db
      .prepare("SELECT customer_id FROM customer_sessions WHERE token_hash = ? AND expires_at > ?")
      .get(tokenHash, at) as { customer_id: string } | undefined;
    if (!session) return "signed-out";
    const updated = db
      .prepare(
        "UPDATE customers SET password_hash = ?, password_salt = ? WHERE id = ? AND password_hash = ? AND password_salt = ?"
      )
      .run(next.hash, next.salt, session.customer_id, verified.hash, verified.salt);
    if (updated.changes !== 1) return "changed-meanwhile";
    db.prepare("DELETE FROM customer_sessions WHERE customer_id = ? AND token_hash <> ?").run(
      session.customer_id,
      tokenHash
    );
    // The password it would have replaced is gone, so any outstanding link is too.
    db.prepare("DELETE FROM password_resets WHERE customer_id = ?").run(session.customer_id);
    return "changed";
  });
}

// A customer has at most one reset link at a time: a new one replaces the earlier one.

/** Stores a customer's reset token, as a hash, until `expiresAt`; expired links are removed with it. */
export function insertPasswordReset(customerId: string, tokenHash: string, expiresAt: number, at: number): void {
  immediate((db) => {
    db.prepare("DELETE FROM password_resets WHERE expires_at <= ?").run(at);
    db.prepare(
      `INSERT INTO password_resets (customer_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(customer_id) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at,
         expires_at = excluded.expires_at`
    ).run(customerId, tokenHash, at, expiresAt);
  });
}

/** The customer a reset token is for while it is live; undefined for any other token, or once it has expired. */
export function passwordResetCustomer(tokenHash: string, at: number): CustomerRow | undefined {
  return database()
    .prepare(
      `SELECT c.* FROM customers c JOIN password_resets r ON r.customer_id = c.id
       WHERE r.token_hash = ? AND r.expires_at > ?`
    )
    .get(tokenHash, at) as CustomerRow | undefined;
}

/**
 * Sets a customer's password, ends every session of theirs and uses up the
 * reset token, in one transaction: a link sets one password however many
 * requests carry it. False, changing nothing, when the token is no longer
 * live (used, replaced by a newer link, or expired while the password was
 * being hashed).
 */
export function consumePasswordReset(tokenHash: string, next: StoredPassword, at: number): boolean {
  return immediate((db) => {
    const reset = db
      .prepare("SELECT customer_id FROM password_resets WHERE token_hash = ? AND expires_at > ?")
      .get(tokenHash, at) as { customer_id: string } | undefined;
    if (!reset) return false;
    db.prepare("UPDATE customers SET password_hash = ?, password_salt = ? WHERE id = ?").run(
      next.hash,
      next.salt,
      reset.customer_id
    );
    db.prepare("DELETE FROM password_resets WHERE customer_id = ?").run(reset.customer_id);
    db.prepare("DELETE FROM customer_sessions WHERE customer_id = ?").run(reset.customer_id);
    return true;
  });
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
         instructions, greeting, studio, public_id, webhook_secret_enc, traces_headers_enc, created_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
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
      row.studio,
      row.public_id,
      row.webhook_secret_enc,
      row.traces_headers_enc,
      row.created_at
    );
    return true;
  });
}

export function storeInstallSignal(projectId: string, kind: InstallSignalKind, at: number) {
  database()
    .prepare(
      `INSERT INTO website_install_signals(project_id,kind,at)
    SELECT id, ?, ? FROM projects WHERE id=? AND deleted_at IS NULL
    ON CONFLICT(project_id) DO UPDATE SET kind=excluded.kind,at=excluded.at
    WHERE excluded.at >= website_install_signals.at
      AND (excluded.kind <> website_install_signals.kind OR excluded.at - website_install_signals.at >= 5000)`
    )
    .run(kind, at, projectId);
}

/** The first answered website conversation outlives transcript retention and project edits. */
export function markWebsiteConversation(projectId: string, at: number): void {
  database()
    .prepare(
      `UPDATE projects SET first_website_conversation_at = ? WHERE id = ? AND deleted_at IS NULL
       AND (first_website_conversation_at IS NULL OR first_website_conversation_at > ?)`
    )
    .run(at, projectId, at);
}

/** Keep deleted projects in their creation cohort so abandonment stays visible. */
export function studioActivation(at: number): StudioActivation {
  const windowDays = 30;
  const metrics = database()
    .prepare(
      `WITH cohort AS (
         SELECT CASE WHEN first_website_conversation_at BETWEEN created_at AND $at
                     THEN first_website_conversation_at - created_at END AS elapsed
         FROM projects WHERE created_at BETWEEN $start AND $at
       ), ranked AS (
         SELECT elapsed, ROW_NUMBER() OVER (ORDER BY elapsed) AS position, COUNT(*) OVER () AS n
         FROM cohort WHERE elapsed IS NOT NULL
       )
       SELECT COUNT(*) AS newProjects, COUNT(elapsed) AS activatedProjects,
              (SELECT AVG(elapsed) FROM ranked WHERE position BETWEEN (n + 1) / 2 AND (n + 2) / 2) AS medianTimeMs
       FROM cohort`
    )
    .get({ $start: at - windowDays * 86_400_000, $at: at }) as Omit<StudioActivation, "windowDays">;
  return { windowDays, ...metrics };
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

export function liveProjectByPublicId(publicId: string): ProjectRow | undefined {
  return database().prepare("SELECT * FROM projects WHERE public_id = ? AND deleted_at IS NULL").get(publicId) as
    ProjectRow | undefined;
}

export function liveProjectByKeyHash(keyHash: string): ProjectRow | undefined {
  return database().prepare("SELECT * FROM projects WHERE key_hash = ? AND deleted_at IS NULL").get(keyHash) as
    ProjectRow | undefined;
}

/** A live preview stays pinned to the version the owner saw when starting it. */
export function readStudioLiveRevision(
  projectId: string,
  customerId: string,
  expectedRevision: string,
  options?: { requireNoDraft?: boolean }
): ProjectRow | undefined {
  return database()
    .prepare(
      `
    SELECT p.* FROM projects p WHERE p.id=? AND p.customer_id=? AND p.deleted_at IS NULL AND p.studio_revision=?
      AND (?=0 OR NOT EXISTS(SELECT 1 FROM studio_snapshots s WHERE s.project_id=p.id AND s.role='draft'))
  `
    )
    .get(projectId, customerId, expectedRevision, options?.requireNoDraft ? 1 : 0) as ProjectRow | undefined;
}

/** Read a pinned draft and the project's current identity together, including on relay checkpoints. */
export function readStudioDraft(projectId: string, customerId: string, revision: string): ProjectRow | undefined {
  const row = database()
    .prepare(
      `
    SELECT p.*, s.config AS draft_config, s.model_key_enc AS draft_model_key, s.traces_headers_enc AS draft_headers
    FROM projects p JOIN studio_snapshots s ON s.project_id = p.id AND s.role = 'draft'
    WHERE p.id = ? AND p.customer_id = ? AND p.deleted_at IS NULL AND s.revision = ?
  `
    )
    .get(projectId, customerId, revision) as
    (ProjectRow & { draft_config: string; draft_model_key: string | null; draft_headers: string | null }) | undefined;
  if (!row) return undefined;
  const { draft_config, draft_model_key, draft_headers, ...live } = row;
  return { ...live, ...JSON.parse(draft_config), model_key_enc: draft_model_key, traces_headers_enc: draft_headers };
}

export type ProjectChanges = Partial<
  Pick<
    ProjectRow,
    | "name"
    | "backend"
    | "model_key_enc"
    | "assistant_name"
    | "instructions"
    | "greeting"
    | "studio"
    | "public_id"
    | "webhook_secret_enc"
    | "traces_headers_enc"
    | "monthly_minutes_cap"
    | "per_user_minutes_cap"
  >
>;

const PROJECT_COLUMNS = [
  "name",
  "backend",
  "model_key_enc",
  "assistant_name",
  "instructions",
  "greeting",
  "studio",
  "public_id",
  "webhook_secret_enc",
  "traces_headers_enc",
  "monthly_minutes_cap",
  "per_user_minutes_cap"
] as const;

/** Applies changes to a live project of `customerId`; false when there is no such project. */
export function updateProject(
  projectId: string,
  customerId: string,
  changes: ProjectChanges,
  studioRevision?: string
): boolean {
  const columns = PROJECT_COLUMNS.filter((column) => changes[column] !== undefined);
  if (!columns.length) return Boolean(liveProject(projectId, customerId));
  const assignments = columns.map((column) => `${column} = ?`);
  const versioned = columns.filter(
    (column) =>
      column !== "webhook_secret_enc" &&
      column !== "public_id" &&
      column !== "monthly_minutes_cap" &&
      column !== "per_user_minutes_cap"
  );
  const values = columns.map((column) => changes[column] ?? null);
  if (studioRevision) {
    assignments.push("studio_revision = ?");
    values.push(studioRevision);
  } else if (versioned.length) {
    const changed = versioned.map((column) => `${column} IS NOT ?`).join(" OR ");
    assignments.push(`studio_revision = CASE WHEN studio_revision IS NOT NULL AND (${changed})
      THEN 'rev_' || lower(hex(randomblob(16))) ELSE studio_revision END`);
    values.push(...versioned.map((column) => changes[column] ?? null));
  }
  const result = database()
    .prepare(`UPDATE projects SET ${assignments.join(", ")} WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`)
    .run(...values, projectId, customerId);
  return result.changes === 1;
}

/** An explicit credential removal also revokes every Studio copy that could restore it. */
export function revokeProjectModelKey(
  projectId: string,
  customerId: string,
  changes: ProjectChanges,
  nextRevision: string
): boolean {
  return immediate((db) => {
    if (!updateProject(projectId, customerId, { ...changes, model_key_enc: null }, nextRevision)) return false;
    // Advancing live normally retains its predecessor. Remove that recovery path as part of the same write.
    db.prepare("DELETE FROM studio_snapshots WHERE project_id = ?").run(projectId);
    return true;
  });
}

export function replaceProjectKey(projectId: string, customerId: string, keyHash: string, keyPrefix: string): boolean {
  const result = database()
    .prepare("UPDATE projects SET key_hash = ?, key_prefix = ? WHERE id = ? AND customer_id = ? AND deleted_at IS NULL")
    .run(keyHash, keyPrefix, projectId, customerId);
  return result.changes === 1;
}

/**
 * Deletes a project in one transaction with everything its deletion erases
 * (ERASED), its transcripts, its saved revisions and its usage per end user
 * included. All happen or
 * none does, so a failure in between (a full disk) leaves the project live for
 * a retry to delete, and never a deleted project whose conversations linger or
 * whose keys could still be used. The row stays, marked `deleted_at`, with what
 * the activation metrics and past usage need of it. False when there is no
 * such live project.
 */
export function softDeleteProject(projectId: string, customerId: string, at: number): boolean {
  return immediate((db) => {
    const deleted = db
      .prepare(
        `UPDATE projects SET deleted_at = ?, ${ERASE_TO} WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`
      )
      .run(at, projectId, customerId);
    if (deleted.changes !== 1) return false;
    db.prepare("DELETE FROM conversations WHERE project_id = ? AND customer_id = ?").run(projectId, customerId);
    // Its usage per end user goes with it, and nothing still to be booked for it names a user from here on: the
    // sessions still running are closed within seconds, and their rows go with their booking.
    db.prepare("DELETE FROM user_usage WHERE project_id = ?").run(projectId);
    db.prepare("UPDATE live_sessions SET user_id = NULL WHERE project_id = ?").run(projectId);
    // After the update, since erasing a live revision makes the relay's trigger keep a copy of the row as it was.
    db.prepare("DELETE FROM studio_snapshots WHERE project_id = ?").run(projectId);
    return true;
  });
}

// --- ledger ---------------------------------------------------------------------
// Every entry inserted here moves its customer's balance_fen with it: the
// trigger ledger_entry_moves_balance does so in the transaction of the insert.

/** Covered by idx_ledger_customer_month_free: summed from the index, without reading the entries. */
function freeSecondsUsedIn(db: DatabaseSync, customerId: string, month: string): number {
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(free_seconds), 0) AS used FROM ledger WHERE customer_id = ? AND kind = 'usage' AND month = ?"
    )
    .get(customerId, month) as { used: number };
  return row.used;
}

/**
 * A customer's balance in fen: the sum of their ledger, kept on their row by
 * the trigger, so that one row is read and not the whole ledger. 0 for a
 * customer there is no row for, as the sum of no entries was.
 */
function balanceIn(db: DatabaseSync, customerId: string): number {
  const row = db.prepare("SELECT balance_fen FROM customers WHERE id = ?").get(customerId) as
    { balance_fen: number } | undefined;
  return row?.balance_fen ?? 0;
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
  /** The end user the session's token named, when it named one. */
  userId?: string;
  /** Whole seconds. */
  seconds: number;
  endedAt: number;
  at: number;
};

// `;` is the character after `:`, so the range covers exactly the refs that start with "<id>:rest:".
const SESSION_USAGE = "kind = 'usage' AND (ref = ? OR (ref >= ? AND ref < ?))";

/** Seconds the ledger already holds for a session: its entry and any remainder entries. */
export function sessionSecondsBooked(sessionId: string): number {
  const held = database()
    .prepare(`SELECT COALESCE(SUM(seconds), 0) AS seconds FROM ledger WHERE ${SESSION_USAGE}`)
    .get(sessionId, `${sessionId}:rest:`, `${sessionId}:rest;`) as { seconds: number };
  return held.seconds;
}

/** What the ledger holds for a session so far: its entries, and their seconds, paid seconds and fen. */
type HeldUsage = { entries: number; seconds: number; paid_seconds: number; fen: number };

/**
 * Books a session's usage up to `seconds` in total, idempotently: seconds the
 * ledger already holds for the session are never booked again.
 *
 * A session is one charge, whatever number of entries it takes. Its cost is
 * its paid seconds at the price per minute, rounded up once as a whole, and
 * an entry charges only what the entries before it left of that unpaid. Its
 * free seconds come from the month of its first entry, and so does every
 * entry: the session is booked to that month as a whole.
 *
 * The entry's seconds are added to the session's user's usage of that month
 * as well (user_usage), and a session is one session there too, with its
 * first entry: only while the project is live, as a deleted project keeps
 * none of it.
 *
 * - "booked": the session's first entry, to the month of `endedAt`.
 * - "remainder": the session was booked before for fewer seconds (another
 *   relay took it for abandoned and booked it up to a checkpoint while it was
 *   still running); the difference is booked as a further entry whose ref is
 *   the session id followed by `:rest:<n>`.
 * - "already-booked": the ledger holds at least `seconds` for it.
 */
export function bookUsage(usage: UsageBooking): "booked" | "remainder" | "already-booked" {
  return immediate((db) => {
    const session = [usage.sessionId, `${usage.sessionId}:rest:`, `${usage.sessionId}:rest;`] as const;
    const held = db
      .prepare(
        `SELECT COUNT(*) AS entries, COALESCE(SUM(seconds), 0) AS seconds,
                COALESCE(SUM(seconds - free_seconds), 0) AS paid_seconds, COALESCE(-SUM(amount_fen), 0) AS fen
         FROM ledger WHERE ${SESSION_USAGE}`
      )
      .get(...session) as HeldUsage;
    const seconds = usage.seconds - held.seconds;
    if (held.entries > 0 && seconds <= 0) return "already-booked";
    let month = monthOf(usage.endedAt);
    if (held.entries > 0) {
      const first = db
        .prepare(`SELECT month FROM ledger WHERE ${SESSION_USAGE} ORDER BY id LIMIT 1`)
        .get(...session) as { month: string };
      month = first.month;
    }
    const freeSeconds = usageCharge(
      seconds,
      freeSecondsLeft(freeSecondsUsedIn(db, usage.customerId, month))
    ).freeSeconds;
    // Never below zero: entries written before a session was charged as a whole each rounded up on their own.
    const costFen = Math.max(0, usageCharge(held.paid_seconds + seconds - freeSeconds, 0).costFen - held.fen);
    const ref = held.entries === 0 ? usage.sessionId : `${usage.sessionId}:rest:${held.entries}`;
    db.prepare(
      `INSERT INTO ledger (customer_id, kind, amount_fen, free_seconds, seconds, project_id, ref, month, created_at)
       VALUES (?, 'usage', ?, ?, ?, ?, ?, ?, ?)`
    ).run(usage.customerId, -costFen, freeSeconds, seconds, usage.projectId, ref, month, usage.at);
    if (liveProject(usage.projectId)) {
      addUserUsageIn(db, usage.projectId, month, usage.userId, seconds, held.entries === 0);
    }
    return held.entries === 0 ? "booked" : "remainder";
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

/** Stores an order as `row` says. */
function insertOrderIn(db: DatabaseSync, row: OrderRow): void {
  db.prepare(
    `INSERT INTO orders (id, customer_id, provider, pack, amount_fen, status, provider_txn_id, created_at, paid_at,
       expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
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

/**
 * Stores a pending order unless the customer already holds `limit` unpaid,
 * unexpired ones; false then. The only way an order is stored: the count and
 * the insert are one transaction, so two relays sharing the database (or a
 * relay and a script) cannot both take the last place.
 */
export function insertPendingOrder(row: OrderRow, limit: number, at: number): boolean {
  return immediate((db) => {
    const { count } = db
      .prepare("SELECT COUNT(*) AS count FROM orders WHERE customer_id = ? AND status = 'pending' AND expires_at > ?")
      .get(row.customer_id, at) as { count: number };
    if (count >= limit) return false;
    insertOrderIn(db, row);
    return true;
  });
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

/** Pending orders, the first to expire first; at most `limit`. */
export function pendingOrders(limit: number): OrderRow[] {
  return database()
    .prepare("SELECT * FROM orders WHERE status = 'pending' ORDER BY expires_at, id LIMIT ?")
    .all(limit) as OrderRow[];
}

type ClosedOrderRef = Pick<OrderRow, "id" | "provider" | "expires_at">;

/**
 * Orders closed as unpaid that expired within the last `closedWithin` ms, the
 * most recently expired first and at most `limit`. An order that is closed and
 * has not expired was one the provider could not create: nobody was shown a
 * code to pay, so it is left out. Which of these a sweep asks about is decided
 * from when each was last asked (topups.ts).
 */
export function recentlyClosedOrders(at: number, closedWithin: number, limit: number): ClosedOrderRef[] {
  return database()
    .prepare(
      `SELECT id, provider, expires_at FROM orders
       WHERE status = 'closed' AND expires_at <= ? AND expires_at > ?
       ORDER BY expires_at DESC, id DESC LIMIT ?`
    )
    .all(at, at - closedWithin, limit) as ClosedOrderRef[];
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

export function customerExists(customerId: string): boolean {
  return Boolean(database().prepare("SELECT 1 FROM customers WHERE id = ?").get(customerId));
}

/**
 * Sessions in progress, checkpointed while they run, so a crash or a restart
 * that skips the close handler cannot lose their charge. A row lives until its
 * session is booked:
 *
 *  - while the session runs, its relay process (`instance_id`) updates
 *    `last_seen` and the billable `seconds` so far every few seconds;
 *  - when it ends, `ended_at` and the final `seconds` are written before the
 *    booking, and the row is deleted once the booking is in the ledger. A row
 *    with `ended_at` is a booking that failed and is retried.
 *
 * A running row whose `last_seen` stopped moving belongs to a relay that
 * crashed or was stopped, and is booked up to its last checkpoint. Rows from
 * before these columns existed have no instance and no seconds: their time is
 * `last_seen - started_at`, as it was then.
 */
export type LiveSessionRow = {
  session_id: string;
  customer_id: string;
  project_id: string;
  started_at: number;
  last_seen: number;
  instance_id: string | null;
  seconds: number | null;
  ended_at: number | null;
  /** The end user the session's token named: null for none, and for a row from before users were recorded. */
  user_id: string | null;
};

/** Billable seconds a row stands for: its checkpoint, or for an old row the time it was open. */
export function liveSessionSeconds(row: Pick<LiveSessionRow, "seconds" | "started_at" | "last_seen">): number {
  return row.seconds ?? Math.max(0, (row.last_seen - row.started_at) / 1000);
}

export function startLiveSession(row: {
  sessionId: string;
  customerId: string;
  projectId: string;
  userId?: string;
  instanceId: string;
  at: number;
}): void {
  database()
    .prepare(
      `INSERT OR REPLACE INTO live_sessions
         (session_id, customer_id, project_id, user_id, started_at, last_seen, instance_id, seconds, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL)`
    )
    .run(row.sessionId, row.customerId, row.projectId, row.userId ?? null, row.at, row.at, row.instanceId);
}

/**
 * A checkpoint of a running session. When its row is missing (its start could
 * not be recorded, or another relay took it for abandoned and booked it) the
 * row is written again, so a crash from here on still has something to book.
 * Returns "restored" in that case, and "ended" for a session already ended.
 */
export function touchLiveSession(row: {
  sessionId: string;
  customerId: string;
  projectId: string;
  userId?: string;
  instanceId: string;
  at: number;
  seconds: number;
}): "updated" | "restored" | "ended" {
  const db = database();
  const updated = db
    .prepare("UPDATE live_sessions SET last_seen = ?, seconds = ? WHERE session_id = ? AND ended_at IS NULL")
    .run(row.at, row.seconds, row.sessionId);
  if (updated.changes === 1) return "updated";
  const restored = db
    .prepare(
      `INSERT OR IGNORE INTO live_sessions
         (session_id, customer_id, project_id, user_id, started_at, last_seen, instance_id, seconds, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    )
    .run(
      row.sessionId,
      row.customerId,
      row.projectId,
      row.userId ?? null,
      Math.round(row.at - row.seconds * 1000),
      row.at,
      row.instanceId,
      row.seconds
    );
  return restored.changes === 1 ? "restored" : "ended";
}

/** Records how a session ended, before it is booked, so a failed booking can be retried. */
export function finishLiveSession(row: {
  sessionId: string;
  customerId: string;
  projectId: string;
  /** The session's user, for a row that has to be written here; one that exists keeps what its start recorded. */
  userId?: string;
  instanceId: string;
  seconds: number;
  endedAt: number;
}): void {
  database()
    .prepare(
      `INSERT INTO live_sessions
         (session_id, customer_id, project_id, user_id, started_at, last_seen, instance_id, seconds, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         last_seen = excluded.last_seen, seconds = excluded.seconds, ended_at = excluded.ended_at`
    )
    .run(
      row.sessionId,
      row.customerId,
      row.projectId,
      row.userId ?? null,
      Math.round(row.endedAt - row.seconds * 1000),
      row.endedAt,
      row.instanceId,
      row.seconds,
      row.endedAt
    );
}

export function endLiveSession(sessionId: string): void {
  database().prepare("DELETE FROM live_sessions WHERE session_id = ?").run(sessionId);
}

/**
 * Rows to book now: every ended row (a failed booking, retried by whichever
 * relay gets there first; booking is idempotent), and running rows of any
 * other relay process that has not checkpointed since `staleBefore`.
 */
export function unbookedLiveSessions(instanceId: string, staleBefore: number): LiveSessionRow[] {
  return database()
    .prepare(
      `SELECT * FROM live_sessions
       WHERE ended_at IS NOT NULL OR ((instance_id IS NULL OR instance_id <> ?) AND last_seen < ?)
       ORDER BY started_at`
    )
    .all(instanceId, staleBefore) as LiveSessionRow[];
}

/** Whose rows are asked for: a customer's, a project's, or one end user's in a project. */
export type LiveSessionScope = { customerId: string } | { projectId: string; userId?: string };

/** Rows not yet booked for a customer, a project, or one of its end users: running elsewhere, or waiting for a retried booking. */
export function liveSessionRows(scope: LiveSessionScope): LiveSessionRow[] {
  const db = database();
  if ("customerId" in scope) {
    return db.prepare("SELECT * FROM live_sessions WHERE customer_id = ?").all(scope.customerId) as LiveSessionRow[];
  }
  return scope.userId === undefined
    ? (db.prepare("SELECT * FROM live_sessions WHERE project_id = ?").all(scope.projectId) as LiveSessionRow[])
    : (db
        .prepare("SELECT * FROM live_sessions WHERE project_id = ? AND user_id = ?")
        .all(scope.projectId, scope.userId) as LiveSessionRow[]);
}

/** The owner's monthly minutes limit of a live project; null for none (or no such project). */
export function projectMinutesCap(projectId: string): number | null {
  const row = database()
    .prepare("SELECT monthly_minutes_cap FROM projects WHERE id = ? AND deleted_at IS NULL")
    .get(projectId) as { monthly_minutes_cap: number | null } | undefined;
  return row?.monthly_minutes_cap ?? null;
}

/** Seconds of a project's sessions booked to a month. */
export function projectSecondsIn(projectId: string, month: string): number {
  const row = database()
    .prepare(
      "SELECT COALESCE(SUM(seconds), 0) AS seconds FROM ledger WHERE project_id = ? AND kind = 'usage' AND month = ?"
    )
    .get(projectId, month) as { seconds: number };
  return row.seconds;
}

// --- usage per end user ------------------------------------------------------------
// What a project's sessions used, per calendar month and per end user: the
// `userId` their session tokens named, or '' for a session that named none
// (the public embed, a Studio test), which no userId can be. Written with a
// session's ledger entries, in the same transaction and to the same month, so
// a month's rows add up to the project's usage in the ledger. Deleted with
// the project (softDeleteProject), and never written for a deleted one.

/** Adds a booked entry to its user's usage of the month, in the transaction `db` is in. A session is one session there, with its first entry. */
function addUserUsageIn(
  db: DatabaseSync,
  projectId: string,
  month: string,
  userId: string | undefined,
  seconds: number,
  first: boolean
): void {
  db.prepare(
    `INSERT INTO user_usage (project_id, month, user_id, sessions, seconds) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_id, month, user_id) DO UPDATE SET
       sessions = sessions + excluded.sessions, seconds = seconds + excluded.seconds`
  ).run(projectId, month, userId ?? "", first ? 1 : 0, seconds);
}

/** A user's usage of a month in a project. `userId` is "" for the sessions that named no user. */
type UserUsageRow = { userId: string; sessions: number; seconds: number };

/** What reports call the sessions that named no user, and what `userId` no token may carry: a user of that name could not be told from them. */
export const ANONYMOUS_USER = "anonymous";

const USER_USAGE_OF_PROJECT = "project_id = ? AND month = ?";
const USER_USAGE_OF_USER = `${USER_USAGE_OF_PROJECT} AND user_id = ?`;

/** Seconds of one user's sessions in a project booked to a month. */
export function userSecondsIn(projectId: string, userId: string, month: string): number {
  const row = database()
    .prepare(`SELECT seconds FROM user_usage WHERE ${USER_USAGE_OF_USER}`)
    .get(projectId, month, userId) as { seconds: number } | undefined;
  return row?.seconds ?? 0;
}

/**
 * A project's per-user usage of a month in all: how many users, and their
 * sessions and seconds, the sessions without a user included in those. Of
 * `userId` alone when named, and then it counts that one.
 */
export function userUsageTotals(
  projectId: string,
  month: string,
  userId?: string
): { users: number; sessions: number; seconds: number } {
  // Of a whole month the sessions that named no user are no user: "anonymous" is a bucket, not counted as one.
  const row = database()
    .prepare(
      `SELECT COUNT(*) AS total, COALESCE(MAX(user_id = ''), 0) AS anonymous, COALESCE(SUM(sessions), 0) AS sessions,
              COALESCE(SUM(seconds), 0) AS seconds
       FROM user_usage WHERE ${userId === undefined ? USER_USAGE_OF_PROJECT : USER_USAGE_OF_USER}`
    )
    .get(...(userId === undefined ? [projectId, month] : [projectId, month, userId])) as {
    total: number;
    anonymous: number;
    sessions: number;
    seconds: number;
  };
  return {
    users: row.total - (userId === undefined ? row.anonymous : 0),
    sessions: row.sessions,
    seconds: row.seconds
  };
}

/** A project's users of a month, the ones with the most seconds first (then by userId): `limit` rows from `offset`, or the one named. */
export function userUsageRows(
  projectId: string,
  month: string,
  page: { userId?: string; limit: number; offset: number }
): UserUsageRow[] {
  const db = database();
  if (page.userId !== undefined) {
    return db
      .prepare(`SELECT user_id AS userId, sessions, seconds FROM user_usage WHERE ${USER_USAGE_OF_USER}`)
      .all(projectId, month, page.userId) as UserUsageRow[];
  }
  return db
    .prepare(
      `SELECT user_id AS userId, sessions, seconds FROM user_usage WHERE ${USER_USAGE_OF_PROJECT}
       ORDER BY seconds DESC, user_id LIMIT ? OFFSET ?`
    )
    .all(projectId, month, page.limit, page.offset) as UserUsageRow[];
}

/** The owner's monthly minutes limit on each end user of a live project; null for none (or no such project). */
export function perUserMinutesCap(projectId: string): number | null {
  const row = database()
    .prepare("SELECT per_user_minutes_cap FROM projects WHERE id = ? AND deleted_at IS NULL")
    .get(projectId) as { per_user_minutes_cap: number | null } | undefined;
  return row?.per_user_minutes_cap ?? null;
}

// --- encrypted secrets --------------------------------------------------------------

export type EncryptedSecretColumn = "model_key_enc" | "webhook_secret_enc" | "traces_headers_enc";

/** Every live project's encrypted secrets, for checking and re-encrypting them under a new key. */
type ProjectSecrets = Pick<ProjectRow, "id" | "model_key_enc" | "webhook_secret_enc" | "traces_headers_enc"> & {
  revisionId?: string;
};

export function projectSecrets(): ProjectSecrets[] {
  return database()
    .prepare(
      `
    SELECT id, model_key_enc, webhook_secret_enc, traces_headers_enc, NULL AS revisionId FROM projects
    WHERE deleted_at IS NULL AND (model_key_enc IS NOT NULL OR webhook_secret_enc IS NOT NULL OR traces_headers_enc IS NOT NULL)
    UNION ALL
    SELECT s.project_id, s.model_key_enc, NULL, s.traces_headers_enc, s.revision FROM studio_snapshots s
    JOIN projects p ON p.id=s.project_id WHERE p.deleted_at IS NULL
      AND (s.model_key_enc IS NOT NULL OR s.traces_headers_enc IS NOT NULL)
    ORDER BY id
  `
    )
    .all() as ProjectSecrets[];
}

/** Replaces one encrypted secret only if it is still `from`, so a key the customer saved meanwhile is never undone. */
export function replaceProjectSecret(
  projectId: string,
  column: EncryptedSecretColumn,
  from: string,
  to: string,
  revisionId?: string
): boolean {
  if (revisionId) {
    if (column === "webhook_secret_enc") return false;
    return (
      database()
        .prepare(
          `UPDATE studio_snapshots SET ${column} = ?
      WHERE project_id = ? AND revision = ? AND ${column} = ?`
        )
        .run(to, projectId, revisionId, from).changes === 1
    );
  }
  const result = database()
    .prepare(`UPDATE projects SET ${column} = ? WHERE id = ? AND ${column} = ?`)
    .run(to, projectId, from);
  return result.changes === 1;
}

/** An invitation to sign up for Max Cloud: one use, until it expires. */
export type InviteRow = {
  code: string;
  note: string;
  created_by: string;
  created_at: number;
  expires_at: number;
  used_by: string | null;
  used_at: number | null;
};

export function insertInvite(row: InviteRow): void {
  database()
    .prepare(
      `INSERT INTO cloud_invites (code, note, created_by, created_at, expires_at, used_by, used_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL)`
    )
    .run(row.code, row.note, row.created_by, row.created_at, row.expires_at);
}

/** Invites not yet used and not expired, newest first. */
export function openInvites(at: number): InviteRow[] {
  return database()
    .prepare("SELECT * FROM cloud_invites WHERE used_by IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 200")
    .all(at) as InviteRow[];
}

/** Removes an unused invite; false when there was none. */
export function deleteOpenInvite(code: string): boolean {
  return database().prepare("DELETE FROM cloud_invites WHERE code = ? AND used_by IS NULL").run(code).changes === 1;
}

/**
 * Creates a customer with an invite, in one transaction: the invite must be
 * unused and unexpired, and is used up only when the account is created.
 */
export function insertCustomerWithInvite(
  row: CustomerRow,
  code: string,
  at: number
): "created" | "invalid-invite" | "email-taken" {
  return immediate((db) => {
    const invite = db
      .prepare("SELECT 1 FROM cloud_invites WHERE code = ? AND used_by IS NULL AND expires_at > ?")
      .get(code, at);
    if (!invite) return "invalid-invite";
    const inserted = db
      .prepare(
        `INSERT INTO customers (id, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(email) DO NOTHING`
      )
      .run(row.id, row.email, row.password_hash, row.password_salt, row.created_at);
    if (inserted.changes !== 1) return "email-taken";
    db.prepare("UPDATE cloud_invites SET used_by = ?, used_at = ? WHERE code = ?").run(row.id, at, code);
    return "created";
  });
}

// --- conversations ----------------------------------------------------------------

export type ConversationRow = {
  id: string;
  customer_id: string;
  project_id: string;
  started_at: number;
  ended_at: number;
  seconds: number;
  /** "test" (the console), "embed" (public widget) or "api" (a minted token). */
  source: string;
  /** The first thing the user said, shown in the list. */
  preview: string;
  /** JSON list of ConversationTurn. */
  turns: string;
  /** JSON of the conversation's analysis (server/cloud/analysis.ts), once there is one. */
  analysis?: string | null;
  /** How long the user waited for an answer to begin, in ms: the median over the conversation. */
  answer_ms?: number | null;
};

export function insertConversation(row: ConversationRow): void {
  database()
    .prepare(
      `INSERT OR IGNORE INTO conversations
         (id, customer_id, project_id, started_at, ended_at, seconds, source, preview, turns, answer_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.id,
      row.customer_id,
      row.project_id,
      row.started_at,
      row.ended_at,
      row.seconds,
      row.source,
      row.preview,
      row.turns,
      row.answer_ms ?? null
    );
}

/** A project's conversations, newest first, without their turns. */
export function projectConversations(
  projectId: string,
  customerId: string,
  limit: number
): Omit<ConversationRow, "turns">[] {
  return database()
    .prepare(
      `SELECT id, customer_id, project_id, started_at, ended_at, seconds, source, preview, analysis, answer_ms FROM conversations
       WHERE project_id = ? AND customer_id = ? ORDER BY started_at DESC LIMIT ?`
    )
    .all(projectId, customerId, limit) as Omit<ConversationRow, "turns">[];
}

/** Writes a conversation's analysis next to it. False when the conversation is gone. */
export function setConversationAnalysis(id: string, customerId: string, analysis: string): boolean {
  return (
    Number(
      database()
        .prepare("UPDATE conversations SET analysis = ? WHERE id = ? AND customer_id = ?")
        .run(analysis, id, customerId).changes
    ) > 0
  );
}

export function conversationById(id: string, customerId: string): ConversationRow | undefined {
  return database().prepare("SELECT * FROM conversations WHERE id = ? AND customer_id = ?").get(id, customerId) as
    ConversationRow | undefined;
}

/** Deletes conversations that started before `before`; returns how many. */
export function pruneConversations(before: number): number {
  return Number(database().prepare("DELETE FROM conversations WHERE started_at < ?").run(before).changes);
}
