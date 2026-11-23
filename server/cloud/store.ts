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
      CREATE TABLE IF NOT EXISTS cloud_invites (
        code TEXT PRIMARY KEY,
        note TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_by TEXT NULL,
        used_at INTEGER NULL
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
      CREATE TEMP TRIGGER IF NOT EXISTS studio_project_deleted AFTER UPDATE OF deleted_at ON projects
      WHEN NEW.deleted_at IS NOT NULL
      BEGIN DELETE FROM studio_snapshots WHERE project_id = OLD.id; END;
    `);
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_public_id ON projects(public_id)");
    // A project's minutes this month, read by its spend limit every few seconds while it talks.
    db.exec("CREATE INDEX IF NOT EXISTS idx_ledger_project_month ON ledger(project_id, kind, month)");
    const liveColumns = new Set(
      (db.prepare("PRAGMA table_info(live_sessions)").all() as { name: string }[]).map((column) => column.name)
    );
    if (!liveColumns.has("instance_id")) db.exec("ALTER TABLE live_sessions ADD COLUMN instance_id TEXT NULL");
    if (!liveColumns.has("seconds")) db.exec("ALTER TABLE live_sessions ADD COLUMN seconds REAL NULL");
    if (!liveColumns.has("ended_at")) db.exec("ALTER TABLE live_sessions ADD COLUMN ended_at INTEGER NULL");
    const conversationColumns = new Set(
      (db.prepare("PRAGMA table_info(conversations)").all() as { name: string }[]).map((column) => column.name)
    );
    if (!conversationColumns.has("analysis")) db.exec("ALTER TABLE conversations ADD COLUMN analysis TEXT NULL");
    if (!conversationColumns.has("answer_ms")) db.exec("ALTER TABLE conversations ADD COLUMN answer_ms INTEGER NULL");
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

/** The first answered website conversation outlives transcript retention and project edits. */
export function markWebsiteConversation(projectId: string, at: number): void {
  database()
    .prepare(
      `UPDATE projects SET first_website_conversation_at = ? WHERE id = ? AND deleted_at IS NULL
       AND (first_website_conversation_at IS NULL OR first_website_conversation_at > ?)`
    )
    .run(at, projectId, at);
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
  "monthly_minutes_cap"
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
    (column) => column !== "webhook_secret_enc" && column !== "public_id" && column !== "monthly_minutes_cap"
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

/** Seconds the ledger already holds for a session: its entry and any remainder entries. */
export function sessionSecondsBooked(sessionId: string): number {
  // `;` is the character after `:`, so the range covers exactly the refs that start with "<id>:rest:".
  const held = database()
    .prepare(
      `SELECT COALESCE(SUM(seconds), 0) AS seconds FROM ledger
       WHERE kind = 'usage' AND (ref = ? OR (ref >= ? AND ref < ?))`
    )
    .get(sessionId, `${sessionId}:rest:`, `${sessionId}:rest;`) as { seconds: number };
  return held.seconds;
}

/**
 * Books a session's usage up to `seconds` in total, idempotently: seconds the
 * ledger already holds for the session are never booked again.
 *
 * - "booked": the session's first entry.
 * - "remainder": the session was booked before for fewer seconds (another
 *   relay took it for abandoned and booked it up to a checkpoint while it was
 *   still running); the difference is booked as a further entry whose ref is
 *   the session id followed by `:rest:<n>`.
 * - "already-booked": the ledger holds at least `seconds` for it.
 */
export function bookUsage(usage: UsageBooking): "booked" | "remainder" | "already-booked" {
  return immediate((db) => {
    // `;` is the character after `:`, so the range covers exactly the refs that start with "<id>:rest:".
    const held = db
      .prepare(
        `SELECT COUNT(*) AS entries, COALESCE(SUM(seconds), 0) AS seconds FROM ledger
         WHERE kind = 'usage' AND (ref = ? OR (ref >= ? AND ref < ?))`
      )
      .get(usage.sessionId, `${usage.sessionId}:rest:`, `${usage.sessionId}:rest;`) as {
      entries: number;
      seconds: number;
    };
    const seconds = usage.seconds - held.seconds;
    if (held.entries > 0 && seconds <= 0) return "already-booked";
    const month = monthOf(usage.endedAt);
    const left = freeSecondsLeft(freeSecondsUsedIn(db, usage.customerId, month));
    const { freeSeconds, costFen } = usageCharge(seconds, left);
    const ref = held.entries === 0 ? usage.sessionId : `${usage.sessionId}:rest:${held.entries}`;
    db.prepare(
      `INSERT INTO ledger (customer_id, kind, amount_fen, free_seconds, seconds, project_id, ref, month, created_at)
       VALUES (?, 'usage', ?, ?, ?, ?, ?, ?, ?)`
    ).run(usage.customerId, -costFen, freeSeconds, seconds, usage.projectId, ref, month, usage.at);
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
};

/** Billable seconds a row stands for: its checkpoint, or for an old row the time it was open. */
export function liveSessionSeconds(row: Pick<LiveSessionRow, "seconds" | "started_at" | "last_seen">): number {
  return row.seconds ?? Math.max(0, (row.last_seen - row.started_at) / 1000);
}

export function startLiveSession(row: {
  sessionId: string;
  customerId: string;
  projectId: string;
  instanceId: string;
  at: number;
}): void {
  database()
    .prepare(
      `INSERT OR REPLACE INTO live_sessions
         (session_id, customer_id, project_id, started_at, last_seen, instance_id, seconds, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, NULL)`
    )
    .run(row.sessionId, row.customerId, row.projectId, row.at, row.at, row.instanceId);
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
         (session_id, customer_id, project_id, started_at, last_seen, instance_id, seconds, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`
    )
    .run(
      row.sessionId,
      row.customerId,
      row.projectId,
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
  instanceId: string;
  seconds: number;
  endedAt: number;
}): void {
  database()
    .prepare(
      `INSERT INTO live_sessions
         (session_id, customer_id, project_id, started_at, last_seen, instance_id, seconds, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         last_seen = excluded.last_seen, seconds = excluded.seconds, ended_at = excluded.ended_at`
    )
    .run(
      row.sessionId,
      row.customerId,
      row.projectId,
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

/** Rows not yet booked for a customer or a project: running elsewhere, or waiting for a retried booking. */
export function liveSessionRows(scope: { customerId: string } | { projectId: string }): LiveSessionRow[] {
  const [column, value] = "customerId" in scope ? ["customer_id", scope.customerId] : ["project_id", scope.projectId];
  return database().prepare(`SELECT * FROM live_sessions WHERE ${column} = ?`).all(value) as LiveSessionRow[];
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

export function deleteProjectConversations(projectId: string, customerId: string): number {
  return Number(
    database().prepare("DELETE FROM conversations WHERE project_id = ? AND customer_id = ?").run(projectId, customerId)
      .changes
  );
}

/** Deletes conversations that started before `before`; returns how many. */
export function pruneConversations(before: number): number {
  return Number(database().prepare("DELETE FROM conversations WHERE started_at < ?").run(before).changes);
}
